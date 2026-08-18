import mongoose from 'mongoose';
import { Ticket } from './ticket.model';
import { CreateTicketDTO, UpdateTicketDTO } from './ticket.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'ticket', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Ticket pipeline`);
  }
}

export async function listTickets(tenantId: string, opts: ListOptions = {}, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (status) filter.ticketStatus = status;
  if (relatedModule && relatedId) { filter.relatedModule = relatedModule; filter.relatedId = relatedId; }
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ subject: re }, { contactName: re }, { description: re }];
  }
  const [items, total] = await Promise.all([
    Ticket.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getTicketById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Ticket.findOne(filter).lean();
}

export async function createTicket(tenantId: string, dto: CreateTicketDTO) {
  await assertValidStatus(tenantId, dto.ticketStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Ticket.create({ tenantId: tid, ...dto });
  void sendOnCreateConfirmation(tenantId, 'ticket', created.toObject()); // fire-and-forget, never throws
  return created;
}

export async function updateTicket(tenantId: string, id: string, dto: UpdateTicketDTO, scope?: DataScope) {
  await assertValidStatus(tenantId, dto.ticketStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Ticket.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
}

export async function deleteTicket(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Ticket.findOneAndDelete(filter).lean();
}

export async function getTicketStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const [total, byStatus] = await Promise.all([
    Ticket.countDocuments(filter),
    Ticket.aggregate([{ $match: filter }, { $group: { _id: '$ticketStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
