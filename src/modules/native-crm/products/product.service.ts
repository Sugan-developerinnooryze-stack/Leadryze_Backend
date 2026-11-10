import mongoose from 'mongoose';
import { NativeProduct } from './product.model';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

export async function listProducts(tenantId: string, opts: any, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name: new RegExp(opts.search, 'i') },
    { sku:  new RegExp(opts.search, 'i') },
  ];
  const [items, total] = await Promise.all([
    NativeProduct.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeProduct.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getProductById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { productId: id }] }
    : { productId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeProduct.findOne(filter);
}

export async function createProduct(data: any) {
  const created = await NativeProduct.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'products', created.toObject(), (created as any).name);
  return created;
}

export async function updateProduct(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { productId: id }] }
    : { productId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeProduct.findOneAndUpdate(withExpectedVersion(filter, guard), data, { new: true, runValidators: true });
  if (!updated) await throwIfStale(NativeProduct, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'products', updated.toObject(), (updated as any).name);
  return updated;
}

export async function deleteProduct(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { productId: id }] }
    : { productId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeProduct.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeProduct, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'products', String(deleted._id));
  return deleted;
}
