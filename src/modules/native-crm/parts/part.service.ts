import mongoose from 'mongoose';
import { NativePart } from './part.model';
import { PartListOptions } from './part.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

export async function listParts(tenantId: string, opts: PartListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name:       new RegExp(opts.search, 'i') },
    { partNumber: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativePart.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativePart.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getPartById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { partId: id }] }
    : { partId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativePart.findOne(filter);
}

export async function createPart(data: any) {
  const created = await NativePart.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'parts', created.toObject(), created.name);
  return created;
}

export async function updatePart(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { partId: id }] }
    : { partId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativePart.findOneAndUpdate(
    withExpectedVersion(filter, guard),
    data,
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativePart, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'parts', updated.toObject(), updated.name);
  return updated;
}

export async function deletePart(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { partId: id }] }
    : { partId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativePart.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativePart, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'parts', String(deleted._id));
  return deleted;
}
