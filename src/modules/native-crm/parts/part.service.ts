import mongoose from 'mongoose';
import { NativePart } from './part.model';
import { PartListOptions } from './part.types';

export async function listParts(tenantId: string, opts: PartListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

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

export async function getPartById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativePart.findOne({ _id: id, tenantId: tid });
}

export async function createPart(data: any) {
  return NativePart.create(data);
}

export async function updatePart(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativePart.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deletePart(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativePart.findOneAndDelete({ _id: id, tenantId: tid });
}
