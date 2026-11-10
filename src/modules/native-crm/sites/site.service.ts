import mongoose from 'mongoose';
import { NativeSite } from './site.model';
import { SiteListOptions } from './site.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { preparePiiUpdate } from '../shared/pii-update';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

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
      // LR-R2-SEC-001: only the customer's name (the Sites screens show only
      // that); its phone and e-mail are encrypted at rest and came back as
      // ciphertext inside the site.
      .populate('customerId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    NativeSite.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getSiteById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { siteId: id }] }
    : { siteId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeSite.findOne(filter).populate('customerId', 'name'); // LR-R2-SEC-001: name only, as in listSites
}

export async function createSite(data: any) {
  const created = await NativeSite.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'sites', created.toObject(), created.name);
  return created;
}

export async function updateSite(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { siteId: id }] }
    : { siteId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  // findOneAndUpdate skips the pre('save') hook that encrypts PII on create.
  const updated = await NativeSite.findOneAndUpdate(
    withExpectedVersion(filter, guard),
    preparePiiUpdate(data, 'sites', NativeSite),
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativeSite, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'sites', updated.toObject(), updated.name);
  return updated;
}

export async function deleteSite(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { siteId: id }] }
    : { siteId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeSite.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeSite, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'sites', String(deleted._id));
  return deleted;
}
