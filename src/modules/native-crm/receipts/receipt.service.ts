import mongoose from 'mongoose';
import { NativeReceipt } from './receipt.model';
import { NativeInvoice } from '../invoices/invoice.model';
import { NativeCustomer } from '../customers/customer.model';
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
  if (opts.customerId) {
    filter.customerId = opts.customerId;
    const cust = await NativeCustomer.findOne({ tenantId: tid, customerId: opts.customerId }).select('createdAt').lean();
    if (cust?.createdAt) {
      if (filter.createdAt) {
        filter.$and = [{ createdAt: filter.createdAt }, { createdAt: { $gte: cust.createdAt } }];
        delete filter.createdAt;
      } else {
        filter.createdAt = { $gte: cust.createdAt };
      }
    }
  }

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

export async function syncInvoicePaidAmount(invoiceId: string, tenantId: any) {
  if (!invoiceId || !tenantId) return;
  const tid = typeof tenantId === 'string' ? new mongoose.Types.ObjectId(tenantId) : tenantId;

  // Resolve invoice by human-readable invoiceId or Mongo _id
  const invoiceFilter: any = { tenantId: tid };
  if (mongoose.Types.ObjectId.isValid(invoiceId) && String(new mongoose.Types.ObjectId(invoiceId)) === invoiceId) {
    invoiceFilter.$or = [{ invoiceId }, { _id: new mongoose.Types.ObjectId(invoiceId) }];
  } else {
    invoiceFilter.invoiceId = invoiceId;
  }
  const invoice = await NativeInvoice.findOne(invoiceFilter);
  if (!invoice) return;

  // Aggregate all active receipts matching this invoice
  const receipts = await NativeReceipt.find({
    tenantId: tid,
    $or: [{ invoiceId: invoice.invoiceId }, { invoiceId: String(invoice._id) }],
    status: { $ne: 'refunded' },
  });
  const totalPaid = Math.round(receipts.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) * 100) / 100;
  invoice.paidAmount = totalPaid;
  const totalDue = Number(invoice.servicesAmountWithTax) || 0;
  invoice.paid = totalDue > 0 && totalPaid >= totalDue;

  // Synchronize invoice stage when payment state changes
  if (invoice.paid) {
    if (invoice.status !== 'paid') {
      invoice.status = 'paid';
    }
  } else {
    if (invoice.status === 'paid') {
      invoice.status = 'sent';
    }
  }
  await invoice.save();
}

export async function createReceipt(data: any) {
  // LR-RCPT-002: a receipt must be recorded against an invoice belonging to
  // the same customer it's being created for — not just any invoice id.
  const invoice = await NativeInvoice.findOne({ invoiceId: data.invoiceId, tenantId: data.tenantId });
  if (!invoice) throw new Error(`Invoice "${data.invoiceId}" not found`);
  if (invoice.customerId !== data.customerId) {
    throw new Error(`Invoice "${data.invoiceId}" belongs to a different customer`);
  }

  // LR-R2-RCPT-001: Validate remaining invoice balance and prevent overpayments
  const invoiceTotal = Number(invoice.servicesAmountWithTax) || 0;
  const currentPaid = Number(invoice.paidAmount) || 0;
  const balanceDue = Math.max(0, Math.round((invoiceTotal - currentPaid) * 100) / 100);
  if (balanceDue <= 0) {
    throw new Error(`Invoice "${data.invoiceId}" is already fully paid`);
  }
  const receiptAmount = Number(data.amount) || 0;
  if (receiptAmount <= 0) {
    throw new Error('Receipt amount must be greater than 0');
  }
  if (receiptAmount > balanceDue + 0.001) {
    throw new Error(`Receipt amount (${receiptAmount}) exceeds remaining invoice balance (${balanceDue})`);
  }

  const created = await NativeReceipt.create(data);

  // Keep invoice paid amount and paid flag in sync
  await syncInvoicePaidAmount(data.invoiceId, data.tenantId);

  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'receipts', created.toObject(), (created as any).receiptId);
  return created;
}

export async function updateReceipt(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const existing = await NativeReceipt.findOne(filter);
  if (!existing) return null;

  const oldInvoiceId = existing.invoiceId;
  const targetInvoiceId = data.invoiceId ?? oldInvoiceId;
  const targetStatus = data.status ?? existing.status;
  const newAmount = data.amount !== undefined ? Number(data.amount) : Number(existing.amount);

  // LR-R2-RCPT-001: Prevent overpayment when updating receipt amount or invoice
  if (targetInvoiceId && targetStatus !== 'refunded') {
    const invoice = await NativeInvoice.findOne({ invoiceId: targetInvoiceId, tenantId: tid });
    if (!invoice) throw new Error(`Invoice "${targetInvoiceId}" not found`);

    if (newAmount <= 0) {
      throw new Error('Receipt amount must be greater than 0');
    }

    const otherFilter: any = {
      invoiceId: targetInvoiceId,
      tenantId: tid,
      status: { $ne: 'refunded' },
    };
    if (existing.invoiceId === targetInvoiceId) {
      otherFilter._id = { $ne: existing._id };
    }
    const otherReceipts = await NativeReceipt.find(otherFilter);
    const otherPaid = Math.round(otherReceipts.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) * 100) / 100;
    const invoiceTotal = Number(invoice.servicesAmountWithTax) || 0;
    const balanceForThis = Math.max(0, Math.round((invoiceTotal - otherPaid) * 100) / 100);

    if (balanceForThis <= 0) {
      throw new Error(`Invoice "${targetInvoiceId}" is already fully paid`);
    }
    if (newAmount > balanceForThis + 0.001) {
      throw new Error(`Receipt amount (${newAmount}) exceeds remaining invoice balance (${balanceForThis})`);
    }
  }

  const updated = await NativeReceipt.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) {
    await syncInvoicePaidAmount(updated.invoiceId, tenantId);
    if (oldInvoiceId && oldInvoiceId !== updated.invoiceId) {
      await syncInvoicePaidAmount(oldInvoiceId, tenantId);
    }
    indexNativeSearchRecord(tenantId, 'native-crm', 'receipts', updated.toObject(), (updated as any).receiptId);
  }
  return updated;
}

export async function deleteReceipt(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeReceipt.findOneAndDelete(filter);
  if (deleted) {
    await syncInvoicePaidAmount(deleted.invoiceId, tenantId);
    removeNativeSearchRecord(tenantId, 'native-crm', 'receipts', String(deleted._id));
  }
  return deleted;
}

