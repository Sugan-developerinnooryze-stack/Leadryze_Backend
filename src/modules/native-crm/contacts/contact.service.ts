import mongoose from 'mongoose';
import { Contact } from './contact.model';
import { CreateContactDTO, UpdateContactDTO } from './contact.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';

export async function listContacts(tenantId: string, opts: ListOptions = {}, branchId?: string | null): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
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

export async function getContactById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Contact.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createContact(tenantId: string, dto: CreateContactDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Contact.create({ tenantId: tid, ...dto });
}

export async function updateContact(tenantId: string, id: string, dto: UpdateContactDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Contact.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteContact(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Contact.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getContactStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [total, byStatus] = await Promise.all([
    Contact.countDocuments({ tenantId: tid }),
    Contact.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
