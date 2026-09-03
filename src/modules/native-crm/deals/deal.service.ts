import mongoose from 'mongoose';
import { Deal } from './deal.model';
import { CreateDealDTO, UpdateDealDTO } from './deal.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { customFieldsSearchExpr } from '../shared/custom-field-query';
import { conditionsToMongoFilter } from '../automation-rules/automation-rule.service';
import { IFlowCondition } from '../automation-rules/automation-rule.model';

async function assertValidStage(tenantId: string, stage: string | undefined): Promise<void> {
  if (!stage) return;
  if (!(await isValidStageKey(tenantId, 'deal', stage))) {
    throw new Error(`"${stage}" is not a valid stage for this tenant's Deal pipeline`);
  }
}

export async function listDeals(tenantId: string, opts: ListOptions = {}, branchId?: string | null, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, sortBy, sortDir, customFieldFilters } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  if (status) filter.stage = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { contactName: re }, { companyName: re }, customFieldsSearchExpr(search)];
  }
  if (customFieldFilters) {
    try {
      const conditions: IFlowCondition[] = JSON.parse(customFieldFilters);
      const cfFilter = conditionsToMongoFilter(conditions);
      if (Object.keys(cfFilter).length > 0) filter.$and = [...((filter.$and as any[]) ?? []), cfFilter];
    } catch { /* malformed filter payload from the client — ignored, not a 500 */ }
  }
  const sort: Record<string, 1 | -1> = sortBy ? { [sortBy]: sortDir === 'asc' ? 1 : -1 } : { createdAt: -1 };
  const [items, total] = await Promise.all([
    Deal.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Deal.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getDealById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  return Deal.findOne(filter).lean();
}

export async function createDeal(tenantId: string, dto: CreateDealDTO) {
  await assertValidStage(tenantId, dto.stage);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Deal.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'deals', created.toObject(), created.title);
  return created;
}

export async function updateDeal(tenantId: string, id: string, dto: UpdateDealDTO, scope?: DataScope) {
  await assertValidStage(tenantId, dto.stage);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const updated = await Deal.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
  if (updated) indexNativeSearchRecord(tenantId, 'native', 'deals', updated, updated.title);
  return updated;
}

export async function deleteDeal(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const deleted = await Deal.findOneAndDelete(filter).lean();
  if (deleted) removeNativeSearchRecord(tenantId, 'native', 'deals', String(deleted._id));
  return deleted;
}

export async function getDealStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const [total, byStage, totalValue] = await Promise.all([
    Deal.countDocuments(filter),
    Deal.aggregate([{ $match: filter }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    Deal.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  return {
    total,
    byStatus: Object.fromEntries(byStage.map((r) => [r._id as string, r.count as number])),
    totalValue: totalValue[0]?.total ?? 0,
  };
}
