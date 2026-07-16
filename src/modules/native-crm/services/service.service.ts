import mongoose from 'mongoose';
import { NativeService } from './service.model';
import { ServiceListOptions } from './service.types';

export async function listServices(tenantId: string, opts: ServiceListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

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

export async function getServiceById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeService.findOne({ _id: id, tenantId: tid }).populate('categoryId', 'name color icon');
}

export async function createService(data: any) {
  return NativeService.create(data);
}

export async function updateService(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeService.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteService(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeService.findOneAndDelete({ _id: id, tenantId: tid });
}
