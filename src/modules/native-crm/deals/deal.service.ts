import mongoose from 'mongoose';
import { Deal } from './deal.model';
import { CreateDealDTO, UpdateDealDTO } from './deal.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { isValidStageKey, getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { resolveDateRange, resolvePriorDateRange, applyDateRangeToFilter, fillDailySeries, sparklineWindowStart, SPARKLINE_DAYS } from '../shared/date-range';
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
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  if (status) filter.stage = status;
  // LR-CONTACT-001: a Contact's Deals tab used to match by fuzzy
  // contactName text (two different "John Smith"s would show on each
  // other's page) — contactId is a real, unambiguous reference.
  if ((opts as { contactId?: string }).contactId) filter.contactId = (opts as { contactId?: string }).contactId;
  // LR-OPP-001 (Company half): same reasoning as contactId above.
  if ((opts as { companyId?: string }).companyId) filter.companyId = (opts as { companyId?: string }).companyId;
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
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
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
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  // LR-NEG-001: load-then-save instead of findOneAndUpdate() gets Mongoose's
  // built-in __v optimistic-concurrency check for free — two concurrent
  // edits no longer silently overwrite each other.
  const doc = await Deal.findOne(filter);
  if (!doc) return null;
  doc.set(dto);
  await doc.save();
  const updated = doc.toObject();
  indexNativeSearchRecord(tenantId, 'native', 'deals', updated, updated.title);
  return updated;
}

export async function deleteDeal(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  const deleted = await Deal.findOneAndDelete(filter).lean();
  if (deleted) removeNativeSearchRecord(tenantId, 'native', 'deals', String(deleted._id));
  return deleted;
}

export async function getDealStats(tenantId: string, scope?: DataScope, range?: string, customFrom?: string, customTo?: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  // Headline KPI totals (Deals count + Revenue) — all-time, before the
  // range filter below narrows `filter` in place (same reasoning as
  // Customers'/Leads' allTimeTotal).
  const allTimeFilter = { ...filter };
  applyDateRangeToFilter(filter, 'createdAt', resolveDateRange(range, customFrom, customTo));

  // LR-DASH-002: Revenue means closed-WON value only, not every deal
  // regardless of stage — mirrors the tenant's actual Won stage, same
  // helper deal.controller.ts already uses for stage-change side effects.
  const wonKey = await getOutcomeStageKey(tenantId, 'deal', 'won', 'closed_won');
  const revenueFilter = { ...filter, stage: wonKey };
  const allTimeRevenueFilter = { ...allTimeFilter, stage: wonKey };

  const priorRange = resolvePriorDateRange(range, customFrom, customTo);
  const priorFilter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(priorFilter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  if (priorRange) applyDateRangeToFilter(priorFilter, 'createdAt', priorRange);
  const priorRevenueFilter = { ...priorFilter, stage: wonKey };

  // KPI sparkline — fixed 14-day window, independent of `range` (also
  // backs the dashboard's Revenue tile, which reuses Deals' own data).
  const sparklineFilter: Record<string, unknown> = { tenantId: tid, createdAt: { $gte: sparklineWindowStart() } };
  applyDataScopeToFilter(sparklineFilter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');

  const [total, allTimeTotal, byStage, totalValue, allTimeTotalValue, priorTotal, priorTotalValue, dailyRaw] = await Promise.all([
    Deal.countDocuments(filter),
    Deal.countDocuments(allTimeFilter),
    Deal.aggregate([{ $match: filter }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    Deal.aggregate([{ $match: revenueFilter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Deal.aggregate([{ $match: allTimeRevenueFilter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    priorRange ? Deal.countDocuments(priorFilter) : Promise.resolve(null),
    priorRange ? Deal.aggregate([{ $match: priorRevenueFilter }, { $group: { _id: null, total: { $sum: '$amount' } } }]) : Promise.resolve(null),
    Deal.aggregate([
      { $match: sparklineFilter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    ]),
  ]);
  return {
    total,
    allTimeTotal,
    byStatus: Object.fromEntries(byStage.map((r) => [r._id as string, r.count as number])),
    totalValue: totalValue[0]?.total ?? 0,
    allTimeTotalValue: allTimeTotalValue[0]?.total ?? 0,
    priorTotal,
    priorTotalValue: priorTotalValue ? (priorTotalValue[0]?.total ?? 0) : null,
    daily: fillDailySeries(dailyRaw as any[], SPARKLINE_DAYS),
  };
}
