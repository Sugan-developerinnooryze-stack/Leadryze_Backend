import mongoose from 'mongoose';
import { NativeCustomer } from './customer.model';
import { CustomerListOptions } from './customer.types';
import { ensureCredentials } from '../shared/app-credentials.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';

export async function listCustomers(tenantId: string, opts: CustomerListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name:  new RegExp(opts.search, 'i') },
    { email: new RegExp(opts.search, 'i') },
    { phone: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeCustomer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeCustomer.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getCustomerById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  return NativeCustomer.findOne(filter);
}

export async function createCustomer(data: any) {
  const doc = await NativeCustomer.create(data);
  // Auto-generate customer-app login credentials — never blocks/breaks creation
  await ensureCredentials(NativeCustomer, doc._id, doc.tenantId, data.name ?? '');
  return doc;
}

export async function updateCustomer(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  return NativeCustomer.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteCustomer(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  return NativeCustomer.findOneAndDelete(filter);
}

/** New — mirrors Lead.stats()/Meeting.stats()' own already-scoped pattern
 * exactly (no Customer aggregate endpoint existed before this). Feeds the
 * Supervisor dashboard's 3rd stat tile — correctly scoped to a Manager's
 * own team(s) or an Agent's own records via the same applyDataScopeToFilter
 * every other Customer query already uses. */
export async function getCustomerStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const matchFilter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(matchFilter, scope, 'assignedStaffId');
  const [total, byStatus] = await Promise.all([
    NativeCustomer.countDocuments(matchFilter),
    NativeCustomer.aggregate([{ $match: matchFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
