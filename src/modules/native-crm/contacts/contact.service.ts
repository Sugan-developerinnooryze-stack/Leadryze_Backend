import mongoose from 'mongoose';
import { Contact } from './contact.model';
import { CreateContactDTO, UpdateContactDTO } from './contact.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
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
  if (ownerTab === 'unassigned') {
    // LR-CONTACT-005: "Unassigned" was checking createdBy — a Contact
    // always has a creator, so that can never match anything. "Unassigned"
    // means no contactOwner set, a separate field entirely; the base scope
    // (not the ownerTab) still applies, same as every other list.
    applyDataScopeToCreatedByFilter(filter, scope, 'createdBy');
    // $in:[null,''] also matches a missing field — no separate $exists
    // clause needed, and this way it can't collide with the search block's
    // own $or below.
    filter.contactOwner = { $in: [null, ''] };
  } else if (ownerTab === 'my') {
    // LR-CONTACT-005: "My Contacts" filters by contactOwner = signed-in user,
    // NOT createdBy (a creator is not necessarily the owner, and an unowned contact
    // created by the current user must not appear in "My Contacts").
    applyDataScopeToCreatedByFilter(filter, scope, 'createdBy');
    if (userId) {
      const possibleOwners: string[] = [userId];
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
      filter.contactOwner = { $in: possibleOwners };
    } else {
      filter.contactOwner = '__NO_MATCH__';
    }
  } else {
    applyDataScopeToCreatedByFilter(filter, scope, 'createdBy');
  }
  if (status) filter.status = status;
  // LR-CONTACT-001: real ID link, used by CompanyViewPage.tsx's Contacts
  // tab instead of the previous fuzzy name-match — same pattern as Deal's
  // own companyId filter.
  if ((opts as { companyId?: string }).companyId) filter.companyId = (opts as { companyId?: string }).companyId;
  if (search) {
    // LR-CONTACT-004 & LR-C3-SRCH-001: match phoneSearch with same rule as Leads search
    // plus plaintext phone fallback for unencrypted rows.
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const orClauses: Record<string, unknown>[] = [
      { firstName: re },
      { lastName: re },
      { company: re },
      { phone: re },
    ];
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
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
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
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  // LR-CONTACT-004: findOneAndUpdate() bypasses the pre('save') hook that
  // encrypts email/phone and derives the blind-index search fields — load
  // then save so an edited contact is encrypted exactly like a newly
  // created one, instead of being written back as plaintext.
  const doc = await Contact.findOne(filter);
  if (!doc) return null;

  // LR-NEG-001: Detect stale concurrent save (lost update prevention)
  const clientUpdatedAt = (dto as any).updatedAt ? new Date((dto as any).updatedAt).getTime() : null;
  const clientVersion = (dto as any).__v !== undefined ? Number((dto as any).__v) : ((dto as any).version !== undefined ? Number((dto as any).version) : null);
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
  doc.set(cleanDto);
  await doc.save();
  const updated = doc.toObject();
  indexNativeSearchRecord(tenantId, 'native', 'contacts', updated, `${updated.firstName} ${updated.lastName}`.trim());
  return updated;
}

export async function deleteContact(tenantId: string, id: string, scope?: DataScope): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const res = await Contact.findOneAndDelete(filter);
  if (res) removeNativeSearchRecord(tenantId, 'native', 'contacts', String(res._id));
  return !!res;
}

export async function getContactStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
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

