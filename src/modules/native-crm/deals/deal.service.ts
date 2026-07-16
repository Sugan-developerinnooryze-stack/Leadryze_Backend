import mongoose from 'mongoose';
import { Deal } from './deal.model';
import { CreateDealDTO, UpdateDealDTO } from './deal.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';

export async function listDeals(tenantId: string, opts: ListOptions = {}, branchId?: string | null): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  if (status) filter.stage = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { contactName: re }, { companyName: re }];
  }
  const [items, total] = await Promise.all([
    Deal.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Deal.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getDealById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Deal.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createDeal(tenantId: string, dto: CreateDealDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Deal.create({ tenantId: tid, ...dto });
}

export async function updateDeal(tenantId: string, id: string, dto: UpdateDealDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Deal.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteDeal(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Deal.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getDealStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [total, byStage, totalValue] = await Promise.all([
    Deal.countDocuments({ tenantId: tid }),
    Deal.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    Deal.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  return {
    total,
    byStatus: Object.fromEntries(byStage.map((r) => [r._id as string, r.count as number])),
    totalValue: totalValue[0]?.total ?? 0,
  };
}
