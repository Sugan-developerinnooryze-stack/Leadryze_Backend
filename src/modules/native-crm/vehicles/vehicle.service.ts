import mongoose from 'mongoose';
import { NativeVehicle } from './vehicle.model';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

export async function listVehicles(tenantId: string, opts: any, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);
  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name:               new RegExp(opts.search, 'i') },
    { registrationNumber: new RegExp(opts.search, 'i') },
    { make:               new RegExp(opts.search, 'i') },
  ];
  const [items, total] = await Promise.all([
    NativeVehicle.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeVehicle.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getVehicleById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeVehicle.findOne(filter);
}

export async function createVehicle(data: any) {
  return NativeVehicle.create(data);
}

export async function updateVehicle(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeVehicle.findOneAndUpdate(filter, data, { new: true, runValidators: true });
}

export async function deleteVehicle(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeVehicle.findOneAndDelete(filter);
}
