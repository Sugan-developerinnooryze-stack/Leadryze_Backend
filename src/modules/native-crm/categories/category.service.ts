import mongoose from 'mongoose';
import { NativeCategory } from './category.model';
import { CategoryListOptions } from './category.types';

export async function listCategories(tenantId: string, opts: CategoryListOptions, branchId?: string | null) {
  const tid    = new mongoose.Types.ObjectId(tenantId);
  const page   = Number(opts.page  ?? 1);
  const limit  = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.name = new RegExp(opts.search, 'i');

  const [items, total] = await Promise.all([
    NativeCategory.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeCategory.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getCategoryById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCategory.findOne({ _id: id, tenantId: tid });
}

export async function createCategory(data: any) {
  return NativeCategory.create(data);
}

export async function updateCategory(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCategory.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteCategory(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCategory.findOneAndDelete({ _id: id, tenantId: tid });
}
