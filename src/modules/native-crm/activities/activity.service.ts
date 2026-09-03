import mongoose from 'mongoose';
import { NativeActivity } from './activity.model';
import { ActivityListOptions } from './activity.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

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
  const created = await NativeActivity.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'activities', created.toObject(), (created as any).subject);
  return created;
}

export async function updateActivity(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeActivity.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'activities', updated.toObject(), (updated as any).subject);
  return updated;
}

export async function deleteActivity(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeActivity.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'activities', String(deleted._id));
  return deleted;
}
