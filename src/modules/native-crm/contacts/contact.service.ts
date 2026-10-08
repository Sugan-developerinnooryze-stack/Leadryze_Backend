import mongoose from 'mongoose';
import { Contact } from './contact.model';
import { CreateContactDTO, UpdateContactDTO } from './contact.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { hashEmail } from '../../../platform/pii/pii.service';

// LR-UX-010: mirrors lead.service.ts's resolveLeadSort exactly — Contacts
// never had a server-side sort at all before this (always hardcoded
// createdAt:-1), so "sort by column" only ever reordered the current page.
function resolveContactSort(opts: ListOptions): Record<string, 1 | -1> {
  if (!opts.sortBy) return { createdAt: -1 };
  return { [opts.sortBy]: opts.sortDir === 'asc' ? 1 : -1 };
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
  } else {
    applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', ownerTab, userId);
  }
  if (status) filter.status = status;
  // LR-CONTACT-001: real ID link, used by CompanyViewPage.tsx's Contacts
  // tab instead of the previous fuzzy name-match — same pattern as Deal's
  // own companyId filter.
  if ((opts as { companyId?: string }).companyId) filter.companyId = (opts as { companyId?: string }).companyId;
  if (search) {
    // LR-CONTACT-004: same root cause as LR-LEAD-005 — email/phone are
    // encrypted at rest, so match the blind-index fields instead of the
    // ciphertext columns directly.
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const orClauses: Record<string, unknown>[] = [{ firstName: re }, { lastName: re }, { company: re }];
    const searchDigits = search.replace(/\D/g, '');
    if (searchDigits.length >= 4) orClauses.push({ phoneSearch: new RegExp('^' + searchDigits) });
    if (search.includes('@')) orClauses.push({ emailSearch: hashEmail(search) });
    filter.$or = orClauses;
  }
  const [items, total] = await Promise.all([
    // Case-insensitive collation — same reasoning as LR-LEAD-007 — so a
    // name-based sort reads the way a person actually expects.
    Contact.find(filter).sort(resolveContactSort(opts)).collation({ locale: 'en', strength: 2 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Contact.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getContactById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Contact.findOne(filter).lean();
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
  doc.set(dto);
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
