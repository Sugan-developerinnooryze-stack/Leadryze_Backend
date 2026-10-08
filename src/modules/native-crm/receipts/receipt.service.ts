import mongoose from 'mongoose';
import { NativeReceipt } from './receipt.model';
import { NativeInvoice } from '../invoices/invoice.model';
import { ReceiptListOptions } from './receipt.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listReceipts(tenantId: string, opts: ReceiptListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { receiptId:  new RegExp(opts.search, 'i') },
    { invoiceId:  new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeReceipt.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeReceipt.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getReceiptById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeReceipt.findOne(filter);
}

export async function createReceipt(data: any) {
  // LR-RCPT-002: a receipt must be recorded against an invoice belonging to
  // the same customer it's being created for — not just any invoice id.
  const invoice = await NativeInvoice.findOne({ invoiceId: data.invoiceId, tenantId: data.tenantId });
  if (!invoice) throw new Error(`Invoice "${data.invoiceId}" not found`);
  if (invoice.customerId !== data.customerId) {
    throw new Error(`Invoice "${data.invoiceId}" belongs to a different customer`);
  }

  const created = await NativeReceipt.create(data);

  // LR-RCPT-001: recording a receipt never updated the invoice at all —
  // apply this payment towards it, and mark it paid once fully covered.
  const paidAmount = (invoice.paidAmount ?? 0) + (Number(data.amount) || 0);
  invoice.paidAmount = paidAmount;
  if (paidAmount >= invoice.servicesAmountWithTax) invoice.paid = true;
  await invoice.save();

  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'receipts', created.toObject(), (created as any).receiptId);
  return created;
}

export async function updateReceipt(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeReceipt.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'receipts', updated.toObject(), (updated as any).receiptId);
  return updated;
}

export async function deleteReceipt(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeReceipt.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'receipts', String(deleted._id));
  return deleted;
}
