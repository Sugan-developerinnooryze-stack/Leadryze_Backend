import mongoose from 'mongoose';
import { Task } from './task.model';
import { CreateTaskDTO, UpdateTaskDTO } from './task.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'task', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Task pipeline`);
  }
}

export async function listTasks(tenantId: string, opts: ListOptions = {}, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId, upcoming } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
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

export async function createTask(tenantId: string, dto: CreateTaskDTO) {
  await assertValidStatus(tenantId, dto.taskStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Task.create({ tenantId: tid, ...dto });
  void sendOnCreateConfirmation(tenantId, 'task', created.toObject()); // fire-and-forget, never throws
  return created;
}

export async function updateTask(tenantId: string, id: string, dto: UpdateTaskDTO, scope?: DataScope) {
  await assertValidStatus(tenantId, dto.taskStatus);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Task.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
}

export async function deleteTask(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Task.findOneAndDelete(filter).lean();
}

export async function getTaskStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const now = new Date();
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const [total, byStatus, overdue] = await Promise.all([
    Task.countDocuments(filter),
    Task.aggregate([{ $match: filter }, { $group: { _id: '$taskStatus', count: { $sum: 1 } } }]),
    Task.countDocuments({ ...filter, dueDate: { $lt: now }, taskStatus: { $nin: ['done', 'cancelled'] } }),
  ]);
  return { total, overdue, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
