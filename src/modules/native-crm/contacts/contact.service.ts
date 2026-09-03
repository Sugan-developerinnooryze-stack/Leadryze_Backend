import mongoose from 'mongoose';
import { Contact } from './contact.model';
import { CreateContactDTO, UpdateContactDTO } from './contact.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listContacts(tenantId: string, opts: ListOptions = {}, branchId?: string | null, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  if (status) filter.status = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { company: re }, { phone: re }];
  }
  const [items, total] = await Promise.all([
    Contact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
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

export async function createContact(tenantId: string, dto: CreateContactDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Contact.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'contacts', created.toObject(), `${created.firstName} ${created.lastName}`.trim());
  return created;
}

export async function updateContact(tenantId: string, id: string, dto: UpdateContactDTO, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await Contact.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
  if (updated) indexNativeSearchRecord(tenantId, 'native', 'contacts', updated, `${updated.firstName} ${updated.lastName}`.trim());
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
