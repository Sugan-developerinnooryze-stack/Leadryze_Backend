import mongoose from 'mongoose';
import { NativeAsset } from './asset.model';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listAssets(tenantId: string, opts: any, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name:         new RegExp(opts.search, 'i') },
    { serialNumber: new RegExp(opts.search, 'i') },
  ];
  const [items, total] = await Promise.all([
    NativeAsset.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeAsset.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getAssetById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeAsset.findOne(filter);
}

export async function createAsset(data: any) {
  const created = await NativeAsset.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'assets', created.toObject(), (created as any).name);
  return created;
}

export async function updateAsset(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeAsset.findOneAndUpdate(filter, data, { new: true, runValidators: true });
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'assets', updated.toObject(), (updated as any).name);
  return updated;
}

export async function deleteAsset(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeAsset.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'assets', String(deleted._id));
  return deleted;
}
