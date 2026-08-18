import mongoose from 'mongoose';
import { NativeService } from './service.model';
import { ServiceListOptions } from './service.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

export async function listServices(tenantId: string, opts: ServiceListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status)     filter.status     = opts.status;
  if (opts.categoryId) filter.categoryId = new mongoose.Types.ObjectId(opts.categoryId);
  if (opts.search)     filter.name       = new RegExp(opts.search, 'i');

  const [items, total] = await Promise.all([
    NativeService.find(filter)
      .populate('categoryId', 'name color icon')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    NativeService.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getServiceById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeService.findOne(filter).populate('categoryId', 'name color icon');
}

export async function createService(data: any) {
  return NativeService.create(data);
}

export async function updateService(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeService.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteService(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeService.findOneAndDelete(filter);
}
