import mongoose from 'mongoose';
import { NativeCustomer } from './customer.model';
import { CustomerListOptions } from './customer.types';
import { ensureCredentials } from '../shared/app-credentials.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { resolveDateRange, resolvePriorDateRange, applyDateRangeToFilter, fillDailySeries, sparklineWindowStart, SPARKLINE_DAYS } from '../shared/date-range';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeInvoice } from '../invoices/invoice.model';
import { NativeReceipt } from '../receipts/receipt.model';
import { NativeContract } from '../contracts/contract.model';

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
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'customers', doc.toObject(), doc.name);
  return doc;
}

export async function updateCustomer(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const updated = await NativeCustomer.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'customers', updated.toObject(), updated.name);
  return updated;
}

export async function deleteCustomer(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const existing = await NativeCustomer.findOne(filter).select('customerId').lean();
  if (!existing) return null;

  // LR-DEL-001: Quotation/WorkOrder/Invoice/Receipt/Contract all reference
  // the customer only by this plain customerId string (no cascade, no
  // Mongo ref) — deleting out from under them orphaned every one of those
  // documents. Block the delete instead, same as a real FK constraint
  // would, rather than silently leaving them pointing at nothing.
  const cid = existing.customerId;
  const [quotations, workorders, invoices, receipts, contracts] = await Promise.all([
    NativeQuotation.countDocuments({ tenantId: tid, customerId: cid }),
    NativeWorkorder.countDocuments({ tenantId: tid, customerId: cid }),
    NativeInvoice.countDocuments({ tenantId: tid, customerId: cid }),
    NativeReceipt.countDocuments({ tenantId: tid, customerId: cid }),
    NativeContract.countDocuments({ tenantId: tid, customerId: cid }),
  ]);
  const linked: string[] = [];
  if (quotations) linked.push(`${quotations} quotation${quotations > 1 ? 's' : ''}`);
  if (workorders) linked.push(`${workorders} work order${workorders > 1 ? 's' : ''}`);
  if (invoices)   linked.push(`${invoices} invoice${invoices > 1 ? 's' : ''}`);
  if (receipts)   linked.push(`${receipts} receipt${receipts > 1 ? 's' : ''}`);
  if (contracts)  linked.push(`${contracts} contract${contracts > 1 ? 's' : ''}`);
  if (linked.length) {
    throw new Error(`Cannot delete — this customer has ${linked.join(', ')}. Remove or reassign them first.`);
  }

  const deleted = await NativeCustomer.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'customers', String(deleted._id));
  return deleted;
}

/** Mirrors Lead.stats()/Meeting.stats()' own already-scoped pattern exactly
 * — correctly scoped to a Manager's own team(s) or an Agent's own records
 * via the same applyDataScopeToFilter every other Customer query already
 * uses. Extended to the same range/trend/sparkline shape as every other
 * dashboard stats endpoint (see native-crm/shared/date-range.ts) — this is
 * the tenant's real, operationally-used Customer entity (the one Work
 * Orders/Invoices/Quotations/Contracts actually reference), unlike the
 * separate legacy top-level `customers` module. */
export async function getCustomerStats(tenantId: string, scope?: DataScope, range?: string, customFrom?: string, customTo?: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const baseFilter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(baseFilter, scope, 'assignedStaffId');

  const rangedFilter = { ...baseFilter };
  applyDateRangeToFilter(rangedFilter, 'createdAt', resolveDateRange(range, customFrom, customTo));

  const priorRange = resolvePriorDateRange(range, customFrom, customTo);
  const priorFilter: Record<string, unknown> = { ...baseFilter };
  if (priorRange) applyDateRangeToFilter(priorFilter, 'createdAt', priorRange);

  const sparklineFilter: Record<string, unknown> = { ...baseFilter, createdAt: { $gte: sparklineWindowStart() } };

  const [totalCustomers, newToday, byStatus, priorTotal, dailyRaw] = await Promise.all([
    NativeCustomer.countDocuments(rangedFilter),
    NativeCustomer.countDocuments({ ...baseFilter, createdAt: { $gte: today } }),
    NativeCustomer.aggregate([{ $match: rangedFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    priorRange ? NativeCustomer.countDocuments(priorFilter) : Promise.resolve(null),
    NativeCustomer.aggregate([
      { $match: sparklineFilter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    totalCustomers,
    newToday,
    byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])),
    priorTotal,
    daily: fillDailySeries(dailyRaw as any[], SPARKLINE_DAYS),
  };
}
