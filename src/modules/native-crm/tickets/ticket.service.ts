import mongoose from 'mongoose';
import { Ticket } from './ticket.model';
import { CreateTicketDTO, UpdateTicketDTO } from './ticket.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { getOrCreateSlaPolicy, computeDueDates, deriveSlaStatus, slaStatusMongoFilter } from './ticket-sla-policy.service';
import { SlaStatus } from './ticket.types';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'ticket', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Ticket pipeline`);
  }
}

export async function listTickets(tenantId: string, opts: ListOptions = {}, branchId?: string | null, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId, slaStatus } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  if (status) filter.ticketStatus = status;
  if (relatedModule && relatedId) { filter.relatedModule = relatedModule; filter.relatedId = relatedId; }
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ subject: re }, { contactName: re }, { description: re }];
  }
  if (slaStatus) {
    // $and, not a plain merge — slaStatusMongoFilter('on_track') returns its
    // own top-level $or, which would silently clobber the search filter's
    // $or above if assigned directly onto the same filter object.
    filter.$and = [...((filter.$and as unknown[]) ?? []), slaStatusMongoFilter(slaStatus as SlaStatus)];
  }
  const [rawItems, total] = await Promise.all([
    Ticket.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);
  const items = rawItems.map((t) => ({ ...t, slaStatus: deriveSlaStatus(t) }));
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getTicketById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const item = await Ticket.findOne(filter).lean();
  return item ? { ...item, slaStatus: deriveSlaStatus(item) } : item;
}

export async function createTicket(tenantId: string, dto: CreateTicketDTO) {
  await assertValidStatus(tenantId, dto.ticketStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);

  const priority = dto.priority ?? 'medium';
  const policy = await getOrCreateSlaPolicy(tenantId);
  const slaFields = policy.enabled ? await computeDueDates(tenantId, priority, new Date()) : {};

  const created = await Ticket.create({
    tenantId: tid, ...dto, priority,
    branchId: dto.branchId ? new mongoose.Types.ObjectId(dto.branchId) : null,
    ...slaFields,
  });
  void sendOnCreateConfirmation(tenantId, 'ticket', created.toObject()); // fire-and-forget, never throws
  indexNativeSearchRecord(tenantId, 'native', 'tickets', created.toObject(), created.subject);
  return created;
}

export async function updateTicket(tenantId: string, id: string, dto: UpdateTicketDTO, scope?: DataScope) {
  await assertValidStatus(tenantId, dto.ticketStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);

  const setDto: Record<string, unknown> = { ...dto };
  if (dto.priority !== undefined) {
    const current = await Ticket.findOne(filter).select('priority').lean();
    if (current && current.priority !== dto.priority) {
      const policy = await getOrCreateSlaPolicy(tenantId);
      if (policy.enabled) Object.assign(setDto, await computeDueDates(tenantId, dto.priority, new Date()));
    }
  }

  const updated = await Ticket.findOneAndUpdate(filter, { $set: setDto }, { new: true }).lean();
  if (updated) indexNativeSearchRecord(tenantId, 'native', 'tickets', updated, updated.subject);
  return updated ? { ...updated, slaStatus: deriveSlaStatus(updated) } : updated;
}

export async function deleteTicket(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await Ticket.findOneAndDelete(filter).lean();
  if (deleted) removeNativeSearchRecord(tenantId, 'native', 'tickets', String(deleted._id));
  return deleted;
}

export async function getTicketStats(tenantId: string, branchId?: string | null, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  const [total, byStatus] = await Promise.all([
    Ticket.countDocuments(filter),
    Ticket.aggregate([{ $match: filter }, { $group: { _id: '$ticketStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
