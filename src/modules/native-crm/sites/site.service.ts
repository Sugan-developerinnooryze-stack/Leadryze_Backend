import mongoose from 'mongoose';
import { NativeSite } from './site.model';
import { SiteListOptions } from './site.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';

export async function listSites(tenantId: string, opts: SiteListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

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

export async function getSiteById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeSite.findOne(filter).populate('customerId', 'name phone email');
}

export async function createSite(data: any) {
  return NativeSite.create(data);
}

export async function updateSite(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeSite.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteSite(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeSite.findOneAndDelete(filter);
}
