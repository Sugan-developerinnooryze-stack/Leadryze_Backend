import mongoose from 'mongoose';
import { NativeContract } from './contract.model';
import { NativeCustomer } from '../customers/customer.model';
import { ContractListOptions } from './contract.types';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeInvoice } from '../invoices/invoice.model';
import { generateVisits, computeBalance, serviceRangeSummary, computeContractTotals, visitStartAt } from './schedule.engine';
import { effectiveLineRates } from '../shared/document-totals';
import { isValidStageKey, getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { NativeTeam } from '../teams/team.model';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { resolveDateRange, applyDateRangeToFilter } from '../shared/date-range';
import { applyDynamicFilters } from '../shared/dynamic-filter';
import { getContractFilterCatalog } from './contract.filter-catalog';
import { Tenant } from '../../tenants/tenant.model';
import { zonedTimeToUtc } from '../shared/timezone';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';
import { logger } from '../../../utils/logger';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'contract', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Contract pipeline`);
  }
}

/** True when any service line carries a schedule rule (new master-engine contracts). */
function hasScheduleRules(services: any[]): boolean {
  return Array.isArray(services) && services.some((s) => s?.scheduleRule?.frequency);
}

const CONTRACT_DATE_FIELDS = new Set(['startDate', 'endDate', 'overlap', 'createdAt']);

/**
 * LR-R2-ACT-001: Normalize incoming contract start date.
 * If incoming date string lacks timezone offset (naive ISO "YYYY-MM-DDTHH:mm"),
 * resolves the tenant's configured timezone and converts to true UTC Date to
 * prevent timezone drift upon subsequent saves.
 */
export async function normalizeContractStartDate(tenantId: string, startDate?: string | Date): Promise<Date | undefined> {
  if (!startDate) return undefined;
  if (startDate instanceof Date) return isNaN(startDate.getTime()) ? undefined : startDate;
  const s = String(startDate).trim();
  if (!s) return undefined;
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00.000Z`);
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const tenantDoc = await Tenant.findById(tenantId).select('settings.timezone').lean();
    const tz = tenantDoc?.settings?.timezone || 'Asia/Singapore';
    const [, y, mo, d, h, min] = m.map(Number);
    return zonedTimeToUtc(y, mo - 1, d, h, min, tz);
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? undefined : fallback;
}

export async function listContracts(tenantId: string, opts: ContractListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToFilter(filter, scope, 'staffIds');

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:      new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];
  if (opts.teamId) {
    const team = await NativeTeam.findOne({ _id: opts.teamId, tenantId: tid }).select('teamId').lean();
    filter.teamId = team?.teamId ?? '__no_match__';
  }
  if (opts.staffId) {
    const staffOr = [{ staffId: opts.staffId }, { staffIds: opts.staffId }];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: staffOr }];
      delete filter.$or;
    } else {
      filter.$or = staffOr;
    }
  }
  if (opts.customerId) {
    filter.customerId = opts.customerId;
    const cust = await NativeCustomer.findOne({ tenantId: tid, customerId: opts.customerId }).select('createdAt').lean();
    if (cust?.createdAt) {
      if (filter.createdAt) {
        filter.$and = [{ createdAt: filter.createdAt }, { createdAt: { $gte: cust.createdAt } }];
        delete filter.createdAt;
      } else {
        filter.createdAt = { $gte: cust.createdAt };
      }
    }
  }
  const dateField = opts.dateField && CONTRACT_DATE_FIELDS.has(opts.dateField) ? opts.dateField : 'createdAt';
  const resolvedRange = resolveDateRange(opts.range, opts.dateFrom, opts.dateTo);
  if (dateField === 'overlap') {
    // A contract's active span (startDate..endDate) overlapping the
    // requested window at all — not a single-field range match — so a
    // contract running Sep-Dec still shows while viewing October.
    if (resolvedRange) {
      filter.startDate = { $lte: resolvedRange.end };
      filter.endDate   = { $gte: resolvedRange.start };
    }
  } else {
    applyDateRangeToFilter(filter, dateField, resolvedRange);
  }
  if (opts.filters) {
    const catalog = await getContractFilterCatalog(tenantId, branchId);
    applyDynamicFilters(filter, opts.filters, catalog);
  }

  const [docs, total] = await Promise.all([
    NativeContract.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeContract.countDocuments(filter),
  ]);
  // Attach derived schedule info (balance never stored → can't drift)
  const items = docs.map((doc) => {
    const obj: any = doc.toObject();
    obj.serviceBalance      = computeBalance(obj.visits);
    obj.serviceRangeSummary = serviceRangeSummary(obj.services);
    return obj;
  });
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getContractById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { contractId: id }] }
    : { contractId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'staffIds');
  const doc = await NativeContract.findOne(filter);
  if (!doc) return null;
  const obj: any = doc.toObject();
  obj.serviceBalance      = computeBalance(obj.visits);
  obj.serviceRangeSummary = serviceRangeSummary(obj.services);
  return obj;
}

export async function createContract(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  // LR-R26-CTR-007: discount is a percentage (0-100), as on quotations,
  // invoices and work orders; each line at its own rates, else the header's.
  const header = { discount: data.discount, gstPercentage: data.gstPercentage };
  const totals = computeContractTotals(services, parts, header);

  // Master engine: expand per-service schedule rules into the visit schedule
  if (data.startDate) {
    data.startDate = await normalizeContractStartDate(String(data.tenantId), data.startDate);
  }
  if (data.endDate && typeof data.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.endDate)) {
    data.endDate = new Date(`${data.endDate}T23:59:59.999Z`);
  }

  let visits = data.visits;
  if (hasScheduleRules(services) && data.startDate && data.endDate) {
    visits = generateVisits(services, data.startDate, data.endDate, header);
  }

  const doc = await NativeContract.create({
    ...data,
    ...(visits !== undefined ? { visits } : {}),
    ...totals,
  });
  if (data.quotationId) {
    const mongoId = (doc._id as any).toString();
    // Scoped to this contract's own tenant: the quotation id comes from the
    // caller and is not otherwise checked against it.
    const src = await NativeQuotation.findOne({ tenantId: doc.tenantId, quotationId: data.quotationId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'contract', mongoId }, doc.tenantId).catch(() => {});
  }
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'contracts', doc.toObject(), (doc as any).title);
  return doc;
}

export async function updateContract(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { contractId: id }] }
    : { contractId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'staffIds');
  // LR-R26-CTR-007: the header rates price the visits too, so a change to
  // them regenerates an unlocked schedule like a change of lines or dates.
  const touchesSchedule =
    data.services !== undefined || data.startDate !== undefined || data.endDate !== undefined
    || data.discount !== undefined || data.gstPercentage !== undefined;

  if (data.startDate !== undefined) {
    data.startDate = await normalizeContractStartDate(tenantId, data.startDate);
  }
  if (data.endDate && typeof data.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.endDate)) {
    data.endDate = new Date(`${data.endDate}T23:59:59.999Z`);
  }

  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined
      || data.gstPercentage !== undefined || touchesSchedule) {
    const existing: any = await NativeContract.findOne(filter).lean();
    const services  = data.services        ?? existing?.services        ?? [];
    const parts     = data.parts           ?? existing?.parts           ?? [];
    const header    = {
      discount:      data.discount      ?? existing?.discount      ?? 0,
      gstPercentage: data.gstPercentage ?? existing?.gstPercentage ?? 0,
    };
    // As createContract: each line at its own rates, else the header's.
    Object.assign(data, computeContractTotals(services, parts, header));

    // Regenerate the visit schedule only while no visit has a work order —
    // once any visit is scheduled or completed, the schedule is locked.
    if (touchesSchedule && hasScheduleRules(services)) {
      const start = data.startDate ?? existing?.startDate;
      const end   = data.endDate   ?? existing?.endDate;
      const locked = (existing?.visits ?? []).some(
        (v: any) => v.status === 'scheduled' || v.status === 'completed',
      );
      if (!locked && start && end) {
        data.visits = generateVisits(services, start, end, header);
      }
    }
  }
  const updated = await NativeContract.findOneAndUpdate(
    withExpectedVersion(filter, guard),
    data,
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativeContract, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'contracts', updated.toObject(), (updated as any).title);
  return updated;
}

export async function deleteContract(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { contractId: id }] }
    : { contractId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'staffIds');
  const existing = await NativeContract.findOne(filter);
  if (!existing) return null;

  // LR-C4-DEL-003: Check for linked work orders and invoices before deleting
  const idStr = String(existing._id);
  const contractId = (existing as any).contractId ? String((existing as any).contractId) : null;
  const matchIds = contractId ? [idStr, contractId] : [idStr];

  const [workorders, invoices] = await Promise.all([
    NativeWorkorder.countDocuments({ tenantId: tid, contractId: { $in: matchIds } }),
    NativeInvoice.countDocuments({ tenantId: tid, contractId: { $in: matchIds } }),
  ]);

  const linked: string[] = [];
  if (workorders) linked.push(`${workorders} work order${workorders > 1 ? 's' : ''}`);
  if (invoices)   linked.push(`${invoices} invoice${invoices > 1 ? 's' : ''}`);
  if (linked.length) {
    throw Object.assign(
      new Error(`Cannot delete — this contract has ${linked.join(', ')}. Remove or reassign them first.`),
      { statusCode: 409 }
    );
  }

  const deleted = await NativeContract.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeContract, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'contracts', String(deleted._id));
  return deleted;
}

/** Patch one visit in place (positional operator — never rewrites the array). */
export async function updateVisitStatus(
  id: string,
  tenantId: string,
  visitNumber: number,
  set: { status?: string; workOrderId?: string; woId?: string; notes?: string; serviceDate?: Date },
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const $set: Record<string, unknown> = {};
  if (set.status      !== undefined) $set['visits.$.status']      = set.status;
  if (set.workOrderId !== undefined) $set['visits.$.workOrderId'] = set.workOrderId;
  if (set.woId        !== undefined) $set['visits.$.woId']        = set.woId;
  if (set.notes       !== undefined) $set['visits.$.notes']       = set.notes;
  if (set.serviceDate !== undefined) $set['visits.$.serviceDate'] = set.serviceDate;
  if (!Object.keys($set).length) return null;
  return NativeContract.findOneAndUpdate(
    { _id: id, tenantId: tid, visits: { $elemMatch: { visitNumber } } },
    { $set },
    { new: true },
  );
}

/**
 * LR-R26-SCHED-001: give back visits whose claim is older than olderThanMs
 * and still has no work order linked: a run that stopped between the claim
 * and the work order (a deploy, a crash, the database gone) left them
 * 'scheduled' with nothing behind them, and nothing picks up a scheduled
 * visit again. If the claim's work order was made after all (only its link is
 * missing), it is linked instead. Visits scheduled before claims had a time
 * are not touched. Run at the start of every generator run.
 */
export async function releaseStaleVisitClaims(now: Date = new Date(), olderThanMs = 15 * 60_000): Promise<{ released: number; linked: number }> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = { status: 'scheduled', claimedAt: { $lt: cutoff }, woId: { $in: [null, ''] } };
  const contracts: any[] = await NativeContract.find({ visits: { $elemMatch: stale } })
    .select('_id tenantId contractId visits').lean();
  let released = 0;
  let linked = 0;
  for (const contract of contracts) {
    for (const visit of contract.visits ?? []) {
      if (visit.status !== 'scheduled' || visit.woId || !visit.claimedAt || new Date(visit.claimedAt) >= cutoff) continue;
      const sameClaim = { _id: contract._id, visits: { $elemMatch: { visitNumber: visit.visitNumber, status: 'scheduled', claimedAt: visit.claimedAt } } };
      try {
        const wo: any = await NativeWorkorder.findOne({
          tenantId: contract.tenantId, contractId: contract.contractId, contractVisitNumber: visit.visitNumber,
          createdAt: { $gte: visit.claimedAt },
        }).select('_id workOrderId').lean();
        if (wo) {
          await NativeContract.updateOne(sameClaim, { $set: { 'visits.$.workOrderId': wo.workOrderId, 'visits.$.woId': String(wo._id) } });
          linked++;
        } else {
          await NativeContract.updateOne(sameClaim, { $set: { 'visits.$.status': 'planned' }, $unset: { 'visits.$.claimedAt': 1 } });
          released++;
          logger.warn('Contract visit claim given back: no work order was made', { contractId: contract.contractId, visitNumber: visit.visitNumber });
        }
      } catch (err) {
        logger.error('Contract visit claim check failed', { contractId: contract.contractId, visitNumber: visit.visitNumber, error: (err as Error).message });
      }
    }
  }
  return { released, linked };
}

/**
 * Create work orders for planned visits (all, or a given subset) and mark
 * each visit 'scheduled' with the WO linked. Used by the "Generate All Work
 * Orders" button and the scheduler.
 */
export async function generateWorkordersForVisits(
  id: string,
  tenantId: string,
  opts?: { visitNumbers?: number[]; createdBy?: string },
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const contract: any = await NativeContract.findOne({ _id: id, tenantId: tid }).lean();
  if (!contract) return { created: 0, skipped: 0, error: 'Contract not found' };

  const wanted = opts?.visitNumbers?.length ? new Set(opts.visitNumbers) : null;
  const targets = (contract.visits ?? []).filter(
    (v: any) => v.status === 'planned' && (!wanted || wanted.has(v.visitNumber)),
  );

  // Lazy import avoids a circular dependency (workorder.service imports this module)
  const { createWorkorder } = await import('../workorders/workorder.service');

  const scheduledKey = await getOutcomeStageKey(tenantId, 'workorder', 'scheduled', 'scheduled');

  let created = 0;
  for (const visit of targets) {
    // LR-R26-SCHED-001: claim the visit before creating its work order, so two
    // runs at once (the hourly run and the start-up run, two servers during a
    // deploy, Generate All clicked twice) cannot both create one. Only the run
    // whose update turns this visit from 'planned' to 'scheduled' goes on.
    // The claim carries its time, so one left behind by a run that stopped
    // half-way (a deploy, a crash) is given back later (releaseStaleVisitClaims).
    const claimedAt = new Date();
    const claimed = await NativeContract.findOneAndUpdate(
      { _id: id, tenantId: tid, visits: { $elemMatch: { visitNumber: visit.visitNumber, status: 'planned' } } },
      { $set: { 'visits.$.status': 'scheduled', 'visits.$.claimedAt': claimedAt } },
      { projection: { _id: 1 } },
    );
    if (!claimed) continue;
    try {
      // LR-R26-CTR-007: each line's rates are the visit's own (above 0), else
      // the contract line's, else the contract header's. A visit made before
      // this fix stored 0 for a rate its line did not set, and that 0 won:
      // the work order lost the contract's GST.
      const header = { discount: contract.discount, gstPercentage: contract.gstPercentage };
      const visitServices = (visit.services ?? []).map((vs: any) => {
        const matched = (contract.services ?? []).find((cs: any) => cs.name === vs.name || (cs.serviceId && cs.serviceId === vs.serviceId));
        const lineRates = effectiveLineRates(matched, header);
        const rates = effectiveLineRates(vs, { discount: lineRates.discountPercent, gstPercentage: lineRates.taxPercent });
        return {
          name:            vs.name,
          description:     vs.description ?? matched?.description,
          amount:          vs.amount,
          count:           vs.count,
          taxPercent:      rates.taxPercent,
          discountPercent: rates.discountPercent,
          durationHours:   vs.durationHours,
          serviceId:       vs.serviceId,
          frequency:       vs.frequency,
        };
      });
      // The work order's header: the first line's rates (one line: the same).
      const disc = visitServices[0]?.discountPercent ?? (Number(contract.discount) || 0);
      const gst  = visitServices[0]?.taxPercent ?? (Number(contract.gstPercentage) || 0);

      const wo: any = await createWorkorder({
        tenantId:              contract.tenantId,
        branchId:              contract.branchId ?? null,
        customerId:            contract.customerId,
        contractId:            contract.contractId,
        contractVisitNumber:   visit.visitNumber,
        title:                 `${contract.title} — Visit ${visit.visitNumber}`,
        services:              visitServices,
        discount:              disc,
        gstPercentage:         gst,
        teamId:                contract.teamId,
        staffId:               contract.staffId,
        staffIds:              contract.staffIds ?? [],
        // LR-R26-CTR-007: at the contract's start time, not midnight.
        scheduledDate:         visitStartAt(visit.serviceDate, contract.startDate),
        durationHours:         visit.services?.reduce((s: number, x: any) => s + (Number(x.durationHours) || 0), 0) || undefined,
        status:                scheduledKey,
        priority:              contract.priority && ['low', 'medium', 'high'].includes(contract.priority) ? contract.priority : 'medium',
        createdBy:             opts?.createdBy ?? 'system',
      });
      // createWorkorder's own linkage hook also does this, but createdBy:'system'
      // callers rely on it here — idempotent either way
      await updateVisitStatus(id, tenantId, visit.visitNumber, {
        status:      'scheduled',
        workOrderId: wo?.workOrderId,
        woId:        wo?._id ? String(wo._id) : undefined,
      });
      created++;
    } catch (err) {
      // LR-R26-SCHED-001: say which visit failed (this was silent: a failing
      // run only logged 'created: 0'), and give the visit back unless this
      // claim's work order was made (an older one, e.g. cancelled, does not
      // count), so the next run tries again. Then go on with the others.
      logger.error('Contract visit work order failed', {
        contractId: contract.contractId, visitNumber: visit.visitNumber, error: (err as Error)?.message,
      });
      const made = await NativeWorkorder.exists({
        tenantId: contract.tenantId, contractId: contract.contractId, contractVisitNumber: visit.visitNumber,
        createdAt: { $gte: claimedAt },
      }).catch(() => null);
      if (!made) {
        await NativeContract.updateOne(
          { _id: id, tenantId: tid, visits: { $elemMatch: { visitNumber: visit.visitNumber, status: 'scheduled', claimedAt } } },
          { $set: { 'visits.$.status': 'planned' }, $unset: { 'visits.$.claimedAt': 1 } },
        ).catch((e: Error) => logger.error('Contract visit could not be given back; the next run gives it back', {
          contractId: contract.contractId, visitNumber: visit.visitNumber, error: e?.message,
        }));
      }
    }
  }
  return { created, skipped: targets.length - created };
}
