import mongoose from 'mongoose';
import { NativeProduct } from './product.model';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

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
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeProduct.findOne(filter);
}

export async function createProduct(data: any) {
  return NativeProduct.create(data);
}

export async function updateProduct(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeProduct.findOneAndUpdate(filter, data, { new: true, runValidators: true });
}

export async function deleteProduct(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeProduct.findOneAndDelete(filter);
}
