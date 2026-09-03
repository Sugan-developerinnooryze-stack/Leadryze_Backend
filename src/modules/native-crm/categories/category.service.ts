import mongoose from 'mongoose';
import { NativeCategory } from './category.model';
import { CategoryListOptions } from './category.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listCategories(tenantId: string, opts: CategoryListOptions, branchId?: string | null, scope?: DataScope) {
  const tid    = new mongoose.Types.ObjectId(tenantId);
  const page   = Number(opts.page  ?? 1);
  const limit  = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.name = new RegExp(opts.search, 'i');

  const [items, total] = await Promise.all([
    NativeCategory.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeCategory.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getCategoryById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeCategory.findOne(filter);
}

export async function createCategory(data: any) {
  const doc = await NativeCategory.create(data);
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'categories', doc.toObject(), doc.name);
  return doc;
}

export async function updateCategory(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeCategory.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'categories', updated.toObject(), updated.name);
  return updated;
}

export async function deleteCategory(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeCategory.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'categories', String(deleted._id));
  return deleted;
}
