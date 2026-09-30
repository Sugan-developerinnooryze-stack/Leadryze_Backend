import mongoose from 'mongoose';
import { Task } from './task.model';
import { CreateTaskDTO, UpdateTaskDTO } from './task.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { resolveDateRange, applyDateRangeToFilter } from '../shared/date-range';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'task', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Task pipeline`);
  }
}

export async function listTasks(tenantId: string, opts: ListOptions = {}, branchId?: string | null, scope?: DataScope, userId?: string): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId, upcoming, ownerTab } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', ownerTab, userId);
  if (status) filter.taskStatus = status;
  if (relatedModule && relatedId) { filter.relatedModule = relatedModule; filter.relatedId = relatedId; }
  if (upcoming) filter.dueDate = { $gte: new Date() };
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { assignedTo: re }];
  }
  const [items, total] = await Promise.all([
    Task.find(filter).sort({ dueDate: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Task.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getTaskById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Task.findOne(filter).lean();
}

export async function createTask(tenantId: string, dto: CreateTaskDTO & { createdBy?: string }) {
  await assertValidStatus(tenantId, dto.taskStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Task.create({
    tenantId: tid, ...dto,
    branchId: dto.branchId ? new mongoose.Types.ObjectId(dto.branchId) : null,
  });
  void sendOnCreateConfirmation(tenantId, 'task', created.toObject()); // fire-and-forget, never throws
  indexNativeSearchRecord(tenantId, 'native', 'tasks', created.toObject(), created.title);
  return created;
}

export async function updateTask(tenantId: string, id: string, dto: UpdateTaskDTO, scope?: DataScope) {
  await assertValidStatus(tenantId, dto.taskStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await Task.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
  if (updated) indexNativeSearchRecord(tenantId, 'native', 'tasks', updated, updated.title);
  return updated;
}

export async function deleteTask(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await Task.findOneAndDelete(filter).lean();
  if (deleted) removeNativeSearchRecord(tenantId, 'native', 'tasks', String(deleted._id));
  return deleted;
}

export async function getTaskStats(tenantId: string, branchId?: string | null, scope?: DataScope, range?: string, customFrom?: string, customTo?: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // overdue/dueToday are always real-time signals, independent of the
  // Today/Week/Month range switcher — same rule the dashboard plan applies
  // to Work Orders' overdue count. total/byStatus DO respect range.
  const baseFilter: Record<string, unknown> = { tenantId: tid };
  if (branchId) baseFilter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(baseFilter, scope);

  const rangedFilter = { ...baseFilter };
  applyDateRangeToFilter(rangedFilter, 'createdAt', resolveDateRange(range, customFrom, customTo));

  const [total, allTimeTotal, byStatus, overdue, dueToday] = await Promise.all([
    Task.countDocuments(rangedFilter),
    // Headline/Kanban-header total — all-time, same reasoning as
    // Customers'/Leads'/Deals' allTimeTotal (baseFilter is already unranged).
    Task.countDocuments(baseFilter),
    Task.aggregate([{ $match: rangedFilter }, { $group: { _id: '$taskStatus', count: { $sum: 1 } } }]),
    Task.countDocuments({ ...baseFilter, dueDate: { $lt: now }, taskStatus: { $nin: ['done', 'cancelled'] } }),
    Task.countDocuments({ ...baseFilter, dueDate: { $gte: now, $lte: todayEnd }, taskStatus: { $nin: ['done', 'cancelled'] } }),
  ]);
  return { total, allTimeTotal, overdue, dueToday, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
