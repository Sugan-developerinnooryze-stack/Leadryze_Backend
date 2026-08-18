import mongoose from 'mongoose';
import { NativeActivity } from './activity.model';
import { ActivityListOptions } from './activity.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

export async function listActivities(tenantId: string, opts: ActivityListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.type)   filter.type   = opts.type;
  if (opts.search) filter.$or = [
    { subject:     new RegExp(opts.search, 'i') },
    { description: new RegExp(opts.search, 'i') },
    { assignedTo:  new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeActivity.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeActivity.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getActivityById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeActivity.findOne(filter);
}

export async function createActivity(data: any) {
  return NativeActivity.create(data);
}

export async function updateActivity(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeActivity.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteActivity(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeActivity.findOneAndDelete(filter);
}
