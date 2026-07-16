import mongoose from 'mongoose';
import { NativeSite } from './site.model';
import { SiteListOptions } from './site.types';

export async function listSites(tenantId: string, opts: SiteListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status)     filter.status     = opts.status;
  if (opts.customerId) filter.customerId = new mongoose.Types.ObjectId(opts.customerId);
  if (opts.search) filter.$or = [
    { name:    new RegExp(opts.search, 'i') },
    { address: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeSite.find(filter)
      .populate('customerId', 'name phone email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    NativeSite.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getSiteById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeSite.findOne({ _id: id, tenantId: tid }).populate('customerId', 'name phone email');
}

export async function createSite(data: any) {
  return NativeSite.create(data);
}

export async function updateSite(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeSite.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteSite(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeSite.findOneAndDelete({ _id: id, tenantId: tid });
}
