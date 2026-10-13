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
import { NativeStaff } from '../staffs/staff.model';
import { Contact } from '../contacts/contact.model';
import { Company } from '../companies/company.model';

async function enrichDealsWithContactAndCompany(tenantId: mongoose.Types.ObjectId, deals: any[]): Promise<any[]> {
  if (!deals || deals.length === 0) return deals;

  const contactIdsToFetch = new Set<string>();
  const companyIdsToFetch = new Set<string>();

  for (const d of deals) {
    if (d.contactId && !d.contactName) contactIdsToFetch.add(String(d.contactId));
    if (d.companyId && !d.companyName) companyIdsToFetch.add(String(d.companyId));
  }

  const contactMap = new Map<string, string>();
  const companyMap = new Map<string, string>();

  if (contactIdsToFetch.size > 0) {
    const validContactOids = Array.from(contactIdsToFetch).filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
    const contacts = await Contact.find({
      tenantId,
      $or: [
        { _id: { $in: validContactOids } },
        { clientId: { $in: Array.from(contactIdsToFetch) } },
      ],
    }).select('_id clientId firstName lastName email').lean();
    for (const c of contacts) {
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.email || '';
      contactMap.set(String(c._id), name);
      if (c.clientId) contactMap.set(c.clientId, name);
    }
  }

  if (companyIdsToFetch.size > 0) {
    const validCompanyOids = Array.from(companyIdsToFetch).filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
    const companies = await Company.find({
      tenantId,
      $or: [
        { _id: { $in: validCompanyOids } },
        { clientId: { $in: Array.from(companyIdsToFetch) } },
      ],
    }).select('_id clientId name').lean();
    for (const c of companies) {
      const name = c.name || '';
      companyMap.set(String(c._id), name);
      if (c.clientId) companyMap.set(c.clientId, name);
    }
  }

  for (const d of deals) {
    if (d.contactId && !d.contactName && contactMap.has(String(d.contactId))) {
      d.contactName = contactMap.get(String(d.contactId));
    }
    if (d.companyId && !d.companyName && companyMap.has(String(d.companyId))) {
      d.companyName = companyMap.get(String(d.companyId));
    }
  }

  return deals;
}

async function assertValidOwner(tenantId: string, assignedStaffId: string | undefined): Promise<void> {
  if (!assignedStaffId) return;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const isFsStaff = await NativeStaff.exists({
    tenantId: tid,
    $or: [
      { staffId: assignedStaffId },
      ...(mongoose.isValidObjectId(assignedStaffId) ? [{ _id: new mongoose.Types.ObjectId(assignedStaffId) }] : []),
    ],
  });
  if (isFsStaff) {
    throw new Error('Field Service staff cannot be assigned as Deal Owner. Please select a CRM user.');
  }
}

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
  const sortDirVal: 1 | -1 = sortDir === 'desc' ? -1 : 1;
  const sort: Record<string, 1 | -1> = sortBy
    ? (sortBy === '_displayName' || sortBy === 'name' ? { title: sortDirVal } : { [sortBy]: sortDirVal })
    : { createdAt: -1 };
  const [rawItems, total] = await Promise.all([
    Deal.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Deal.countDocuments(filter),
  ]);
  const items = await enrichDealsWithContactAndCompany(tid, rawItems);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getDealById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  const deal = await Deal.findOne(filter).lean();
  if (!deal) return null;
  const enriched = await enrichDealsWithContactAndCompany(tid, [deal]);
  return enriched[0];
}

export async function createDeal(tenantId: string, dto: CreateDealDTO) {
  await assertValidStage(tenantId, dto.stage);
  await assertValidOwner(tenantId, dto.assignedStaffId);
  const tid = new mongoose.Types.ObjectId(tenantId);
  if (dto.contactId && !dto.contactName) {
    const contact = await Contact.findOne({
      tenantId: tid,
      $or: [
        ...(mongoose.isValidObjectId(dto.contactId) ? [{ _id: new mongoose.Types.ObjectId(dto.contactId) }] : []),
        { clientId: dto.contactId },
      ],
    }).select('firstName lastName email').lean();
    if (contact) dto.contactName = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email || '';
  }
  if (dto.companyId && !dto.companyName) {
    const company = await Company.findOne({
      tenantId: tid,
      $or: [
        ...(mongoose.isValidObjectId(dto.companyId) ? [{ _id: new mongoose.Types.ObjectId(dto.companyId) }] : []),
        { clientId: dto.companyId },
      ],
    }).select('name').lean();
    if (company) dto.companyName = company.name || '';
  }
  const created = await Deal.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'deals', created.toObject(), created.title);
  return created;
}

export async function updateDeal(tenantId: string, id: string, dto: UpdateDealDTO, scope?: DataScope) {
  await assertValidStage(tenantId, dto.stage);
  await assertValidOwner(tenantId, dto.assignedStaffId);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId', undefined, undefined, 'createdBy');
  // LR-NEG-001: load-then-save instead of findOneAndUpdate() gets Mongoose's
  // built-in __v optimistic-concurrency check for free — two concurrent
  // edits no longer silently overwrite each other.
  const doc = await Deal.findOne(filter);
  if (!doc) return null;

  // LR-NEG-001: Detect stale concurrent save (lost update prevention)
  const clientUpdatedAt = (dto as any).updatedAt ? new Date((dto as any).updatedAt).getTime() : null;
  const clientVersion = (dto as any).__v !== undefined ? Number((dto as any).__v) : ((dto as any).version !== undefined ? Number((dto as any).version) : null);
  if (clientVersion !== null && doc.__v !== undefined && doc.__v !== clientVersion) {
    const err: any = new Error('This deal was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientUpdatedAt && (doc as any).updatedAt) {
    const docTime = new Date((doc as any).updatedAt).getTime();
    if (docTime - clientUpdatedAt > 500) {
      const err: any = new Error('This deal was changed by someone else — please reload and try again.');
      err.name = 'VersionError';
      throw err;
    }
  }

  if (dto.contactId && !dto.contactName) {
    const contact = await Contact.findOne({
      tenantId: tid,
      $or: [
        ...(mongoose.isValidObjectId(dto.contactId) ? [{ _id: new mongoose.Types.ObjectId(dto.contactId) }] : []),
        { clientId: dto.contactId },
      ],
    }).select('firstName lastName email').lean();
    if (contact) (dto as any).contactName = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email || '';
  }
  if (dto.companyId && !dto.companyName) {
    const company = await Company.findOne({
      tenantId: tid,
      $or: [
        ...(mongoose.isValidObjectId(dto.companyId) ? [{ _id: new mongoose.Types.ObjectId(dto.companyId) }] : []),
        { clientId: dto.companyId },
      ],
    }).select('name').lean();
    if (company) (dto as any).companyName = company.name || '';
  }

  const { updatedAt: _u, __v: _v, version: _ver, ...cleanDto } = dto as any;
  doc.set(cleanDto);
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
