import mongoose from 'mongoose';
import { NativeAsset } from './asset.model';

export async function listAssets(tenantId: string, opts: any, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
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

export async function getAssetById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeAsset.findOne({ _id: id, tenantId: tid });
}

export async function createAsset(data: any) {
  return NativeAsset.create(data);
}

export async function updateAsset(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeAsset.findOneAndUpdate({ _id: id, tenantId: tid }, data, { new: true, runValidators: true });
}

export async function deleteAsset(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeAsset.findOneAndDelete({ _id: id, tenantId: tid });
}
