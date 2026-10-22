import mongoose from 'mongoose';
import { Contact } from './contact.model';
import { CreateContactDTO, UpdateContactDTO } from './contact.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
import { Deal } from '../deals/deal.model';
import { Lead } from '../leads/lead.model';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { hashEmail } from '../../../platform/pii/pii.service';
import { decrypt, isEncrypted } from '../../../utils/crypto';
import { User } from '../../auth/auth.model';

// LR-UX-010: mirrors lead.service.ts's resolveLeadSort exactly — Contacts
// never had a server-side sort at all before this (always hardcoded
// createdAt:-1), so "sort by column" only ever reordered the current page.
function resolveContactSort(opts: ListOptions): Record<string, 1 | -1> {
  if (!opts.sortBy) return { createdAt: -1 };
  const dir: 1 | -1 = opts.sortDir === 'desc' ? -1 : 1;
  if (opts.sortBy === '_displayName' || opts.sortBy === 'name') {
    return { firstName: dir, lastName: dir };
  }
  return { [opts.sortBy]: dir };
}

export async function listContacts(tenantId: string, opts: ListOptions = {}, branchId?: string | null, scope?: DataScope, userId?: string): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, ownerTab } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  let possibleOwners: string[] = [];
  if (userId) {
    possibleOwners.push(userId);
    if (mongoose.isValidObjectId(userId)) {
      try {
        const userDoc = await User.findById(userId).select('firstName lastName name').lean();
        if (userDoc) {
          const fullName = [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim();
          if (fullName) possibleOwners.push(fullName);
          if ((userDoc as any).name) possibleOwners.push((userDoc as any).name);
        }
      } catch {}
    }
  }

  // LR-C4-PERM-003: Scoping checks both createdBy and contactOwner so records
  // assigned to a Manager/Agent are visible even if created by Admin.
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', ownerTab, userId, 'contactOwner', possibleOwners);
  if (status) filter.status = status;
  // LR-CONTACT-001: real ID link, used by CompanyViewPage.tsx's Contacts
  // tab instead of the previous fuzzy name-match — same pattern as Deal's
  // own companyId filter.
  if ((opts as { companyId?: string }).companyId) filter.companyId = (opts as { companyId?: string }).companyId;
  if (search) {
    const rawSearch = search.trim();
    const re = { $regex: rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const orClauses: Record<string, unknown>[] = [
      { firstName: re },
      { lastName: re },
      { company: re },
      { phone: re },
    ];
    // LR-C4-SRCH-002: Searching across full name ("first last" or "last first")
    const nameTokens = rawSearch.split(/\s+/).filter(Boolean);
    if (nameTokens.length >= 2) {
      const firstToken = nameTokens[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const restTokens = nameTokens.slice(1).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orClauses.push({
        $and: [
          { firstName: new RegExp(firstToken, 'i') },
          { lastName: new RegExp(restTokens, 'i') },
        ],
      });
      orClauses.push({
        $and: [
          { firstName: new RegExp(restTokens, 'i') },
          { lastName: new RegExp(firstToken, 'i') },
        ],
      });
      const fullNamePattern = nameTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      orClauses.push({
        $expr: {
          $regexMatch: {
            input: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] },
            regex: fullNamePattern,
            options: 'i',
          },
        },
      });
    }
    const searchDigits = search.replace(/\D/g, '');
    if (searchDigits.length >= 4) {
      orClauses.push({ phoneSearch: new RegExp('^' + searchDigits) });
    }
    if (search.includes('@')) {
      orClauses.push({ emailSearch: hashEmail(search) });
    }
    if (filter.$or) {
      const existingOr = filter.$or;
      delete filter.$or;
      filter.$and = [...((filter.$and as any[]) ?? []), { $or: existingOr }, { $or: orClauses }];
    } else {
      filter.$or = orClauses;
    }
  }
  const [items, total] = await Promise.all([
    // Case-insensitive collation — same reasoning as LR-LEAD-007 — so a
    // name-based sort reads the way a person actually expects.
    // LR-R2-SEC-001: project out blind-index search hashes so they are never sent to clients
    Contact.find(filter)
      .select('-emailSearch -phoneSearch -emailDomain')
      .sort(resolveContactSort(opts)).collation({ locale: 'en', strength: 2 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Contact.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getContactById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { clientId: id }] }
    : { clientId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', undefined, undefined, 'contactOwner');
  return Contact.findOne(filter).select('-emailSearch -phoneSearch -emailDomain').lean();
}

export async function createContact(tenantId: string, dto: CreateContactDTO & { createdBy?: string }) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Contact.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'contacts', created.toObject(), `${created.firstName} ${created.lastName}`.trim());
  return created;
}

export async function updateContact(tenantId: string, id: string, dto: UpdateContactDTO, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { clientId: id }] }
    : { clientId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', undefined, undefined, 'contactOwner');
  // LR-CONTACT-004: findOneAndUpdate() bypasses the pre('save') hook that
  // encrypts email/phone and derives the blind-index search fields — load
  // then save so an edited contact is encrypted exactly like a newly
  // created one, instead of being written back as plaintext.
  const doc = await Contact.findOne(filter);
  if (!doc) return null;

  // LR-NEG-001: Detect stale concurrent save (lost update prevention) — version token mandatory
  const clientUpdatedAt = (dto as any).updatedAt ? new Date((dto as any).updatedAt).getTime() : null;
  const clientVersion = (dto as any).__v !== undefined ? Number((dto as any).__v) : ((dto as any).version !== undefined ? Number((dto as any).version) : null);
  if (clientVersion === null && clientUpdatedAt === null) {
    const err: any = new Error('This contact was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientVersion !== null && doc.__v !== undefined && doc.__v !== clientVersion) {
    const err: any = new Error('This contact was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientUpdatedAt && (doc as any).updatedAt) {
    const docTime = new Date((doc as any).updatedAt).getTime();
    if (docTime - clientUpdatedAt > 500) {
      const err: any = new Error('This contact was changed by someone else — please reload and try again.');
      err.name = 'VersionError';
      throw err;
    }
  }

  const { updatedAt: _u, __v: _v, version: _ver, ...cleanDto } = dto as any;

  // LR-C4-LEAD-003: If email or phone contains masking characters (* or X),
  // never overwrite real stored PII with the masked string
  const PII_FIELDS = ['email', 'phone', 'mobile'];
  for (const f of PII_FIELDS) {
    const val = (cleanDto as any)[f];
    if (typeof val === 'string' && (val.includes('*') || /X{2,}/.test(val))) {
      delete (cleanDto as any)[f];
    }
  }

  doc.set(cleanDto);
  await doc.save();
  const updated = doc.toObject();
  indexNativeSearchRecord(tenantId, 'native', 'contacts', updated, `${updated.firstName} ${updated.lastName}`.trim());
  return updated;
}

export async function deleteContact(tenantId: string, id: string, scope?: DataScope): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { clientId: id }] }
    : { clientId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', undefined, undefined, 'contactOwner');
  const existing = await Contact.findOne(filter);
  if (!existing) return false;

  // LR-C4-DEL-002: Check for linked deals and leads before deleting
  const idStr = String(existing._id);
  const clientId = (existing as any).clientId ? String((existing as any).clientId) : null;
  const matchIds = clientId ? [idStr, clientId] : [idStr];

  const [deals, leads] = await Promise.all([
    Deal.countDocuments({ tenantId: tid, contactId: { $in: matchIds } }),
    Lead.countDocuments({ tenantId: tid, contactId: { $in: matchIds } }),
  ]);

  const linked: string[] = [];
  if (deals) linked.push(`${deals} deal${deals > 1 ? 's' : ''}`);
  if (leads) linked.push(`${leads} lead${leads > 1 ? 's' : ''}`);
  if (linked.length) {
    throw Object.assign(
      new Error(`Cannot delete — this contact has ${linked.join(', ')}. Remove or reassign them first.`),
      { statusCode: 409 }
    );
  }

  const res = await Contact.findOneAndDelete(filter);
  if (res) removeNativeSearchRecord(tenantId, 'native', 'contacts', String(res._id));
  return !!res;
}

export async function getContactStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', undefined, undefined, 'contactOwner');
  const [total, byStatus] = await Promise.all([
    Contact.countDocuments(filter),
    Contact.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}

/**
 * LR-CONTACT-004: Backfills missing blind-index fields (emailSearch, emailDomain, phoneSearch)
 * for contacts where they were not derived during creation (e.g. from lead conversions or legacy imports).
 */
export async function backfillContactSearchIndices(): Promise<{ total: number; backfilled: number }> {
  const contacts = await Contact.find({
    $or: [
      { emailSearch: { $in: [null, ''] } },
      { phoneSearch: { $in: [null, ''] } },
    ],
  }).lean();

  let backfilled = 0;
  for (const c of contacts) {
    const update: Record<string, any> = {};
    const rawEmail = (c as any).email;
    const rawPhone = (c as any).phone;

    if (rawEmail) {
      try {
        const emailPlain = isEncrypted(rawEmail) ? decrypt(rawEmail) : rawEmail;
        if (emailPlain && emailPlain.includes('@')) {
          update.emailSearch = hashEmail(emailPlain);
          update.emailDomain = emailPlain.split('@')[1]?.toLowerCase() ?? '';
        }
      } catch {}
    }

    if (rawPhone) {
      try {
        const phonePlain = isEncrypted(rawPhone) ? decrypt(rawPhone) : rawPhone;
        if (phonePlain) {
          const digits = phonePlain.replace(/\D/g, '');
          if (digits.length >= 4) {
            update.phoneSearch = digits;
          }
        }
      } catch {}
    }

    if (Object.keys(update).length > 0) {
      await Contact.updateOne({ _id: c._id }, { $set: update });
      backfilled++;
    }
  }

  return { total: contacts.length, backfilled };
}

