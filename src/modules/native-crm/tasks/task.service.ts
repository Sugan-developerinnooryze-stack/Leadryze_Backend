import mongoose from 'mongoose';
import { Task } from './task.model';
import { CreateTaskDTO, UpdateTaskDTO } from './task.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';

export async function listTasks(tenantId: string, opts: ListOptions = {}): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (status) filter.taskStatus = status;
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

export async function getTaskById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Task.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createTask(tenantId: string, dto: CreateTaskDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Task.create({ tenantId: tid, ...dto });
}

export async function updateTask(tenantId: string, id: string, dto: UpdateTaskDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Task.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteTask(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Task.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getTaskStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const now = new Date();
  const [total, byStatus, overdue] = await Promise.all([
    Task.countDocuments({ tenantId: tid }),
    Task.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$taskStatus', count: { $sum: 1 } } }]),
    Task.countDocuments({ tenantId: tid, dueDate: { $lt: now }, taskStatus: { $nin: ['done', 'cancelled'] } }),
  ]);
  return { total, overdue, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
