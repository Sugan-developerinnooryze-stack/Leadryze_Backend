import mongoose from 'mongoose';
import { NativeContract } from './contract.model';
import { ContractListOptions } from './contract.types';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { NativeQuotation } from '../quotations/quotation.model';
import { generateVisits, computeBalance, serviceRangeSummary } from './schedule.engine';

/** True when any service line carries a schedule rule (new master-engine contracts). */
function hasScheduleRules(services: any[]): boolean {
  return Array.isArray(services) && services.some((s) => s?.scheduleRule?.frequency);
}

export async function listContracts(tenantId: string, opts: ContractListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:      new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];

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

export async function getContractById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const doc = await NativeContract.findOne({ _id: id, tenantId: tid });
  if (!doc) return null;
  const obj: any = doc.toObject();
  obj.serviceBalance      = computeBalance(obj.visits);
  obj.serviceRangeSummary = serviceRangeSummary(obj.services);
  return obj;
}

export async function createContract(data: any) {
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(data.discount ?? 0);
  const gst      = Number(data.gstPercentage ?? 0);
  const after    = svcTotal + prtTotal - discount;

  // Master engine: expand per-service schedule rules into the visit schedule
  let visits = data.visits;
  if (hasScheduleRules(services) && data.startDate && data.endDate) {
    visits = generateVisits(services, data.startDate, data.endDate);
  }

  const doc = await NativeContract.create({
    ...data,
    ...(visits !== undefined ? { visits } : {}),
    partsAmount:           prtTotal,
    servicesAmount:        after,
    servicesAmountWithTax: after + (after * gst) / 100,
  });
  if (data.quotationId) {
    const mongoId = (doc._id as any).toString();
    const src = await NativeQuotation.findOne({ quotationId: data.quotationId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'contract', mongoId }).catch(() => {});
  }
  return doc;
}

export async function updateContract(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const touchesSchedule =
    data.services !== undefined || data.startDate !== undefined || data.endDate !== undefined;

  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined
      || data.gstPercentage !== undefined || touchesSchedule) {
    const existing: any = await NativeContract.findOne({ _id: id, tenantId: tid }).lean();
    const services  = data.services        ?? existing?.services        ?? [];
    const parts     = data.parts           ?? existing?.parts           ?? [];
    const discount  = Number(data.discount      ?? existing?.discount      ?? 0);
    const gst       = Number(data.gstPercentage ?? existing?.gstPercentage ?? 0);
    const svcTotal  = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
    const prtTotal  = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
    const after     = svcTotal + prtTotal - discount;
    data.partsAmount           = prtTotal;
    data.servicesAmount        = after;
    data.servicesAmountWithTax = after + (after * gst) / 100;

    // Regenerate the visit schedule only while no visit has a work order —
    // once any visit is scheduled or completed, the schedule is locked.
    if (touchesSchedule && hasScheduleRules(services)) {
      const start = data.startDate ?? existing?.startDate;
      const end   = data.endDate   ?? existing?.endDate;
      const locked = (existing?.visits ?? []).some(
        (v: any) => v.status === 'scheduled' || v.status === 'completed',
      );
      if (!locked && start && end) {
        data.visits = generateVisits(services, start, end);
      }
    }
  }
  return NativeContract.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteContract(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeContract.findOneAndDelete({ _id: id, tenantId: tid });
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

  let created = 0;
  for (const visit of targets) {
    try {
      const wo: any = await createWorkorder({
        tenantId:              contract.tenantId,
        branchId:              contract.branchId ?? null,
        customerId:            contract.customerId,
        contractId:            contract.contractId,
        contractVisitNumber:   visit.visitNumber,
        title:                 `${contract.title} — Visit ${visit.visitNumber}`,
        services:              visit.services ?? [],
        teamId:                contract.teamId,
        staffId:               contract.staffId,
        staffIds:              contract.staffIds ?? [],
        scheduledDate:         visit.serviceDate,
        durationHours:         visit.services?.reduce((s: number, x: any) => s + (Number(x.durationHours) || 0), 0) || undefined,
        status:                'scheduled',
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
    } catch {
      // continue with remaining visits
    }
  }
  return { created, skipped: targets.length - created };
}
