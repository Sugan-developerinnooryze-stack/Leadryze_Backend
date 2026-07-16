import mongoose from 'mongoose';
import { Call } from './call.model';
import { CreateCallDTO, UpdateCallDTO } from './call.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';

export async function listCalls(tenantId: string, opts: ListOptions = {}): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (status) filter.callStatus = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ contactName: re }, { notes: re }];
  }
  const [items, total] = await Promise.all([
    Call.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Call.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getCallById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Call.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createCall(tenantId: string, dto: CreateCallDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Call.create({ tenantId: tid, ...dto });
}

export async function updateCall(tenantId: string, id: string, dto: UpdateCallDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Call.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteCall(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Call.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getCallStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [total, byStatus] = await Promise.all([
    Call.countDocuments({ tenantId: tid }),
    Call.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$callStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
