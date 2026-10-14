import mongoose from 'mongoose';
import { NativeInvoice } from './invoice.model';
import { InvoiceListOptions } from './invoice.types';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeContract }  from '../contracts/contract.model';
import { NativeCustomer }  from '../customers/customer.model';
import { NativeReceipt }   from '../receipts/receipt.model';
import { isValidStageKey, getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { resolveDateRange, applyDateRangeToFilter } from '../shared/date-range';
import { applyDynamicFilters } from '../shared/dynamic-filter';
import { getInvoiceFilterCatalog } from './invoice.filter-catalog';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'invoice', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Invoice pipeline`);
  }
}

const INVOICE_DATE_FIELDS = new Set(['dueDate', 'createdAt']);

/** An invoice referencing a Work Order can only be created once that Work
 * Order has actually reached its tenant's own "completed" stage — the stage
 * KEY is tenant-configurable (pipeline-config.service.ts), so this resolves
 * the real key for the semantic outcome 'completed' rather than comparing
 * against a hardcoded string. Applies to every caller (this service's own
 * createInvoice, used by both the chatbot and the existing Invoices UI),
 * not a chatbot-only check. */
async function assertWorkOrderCompleted(tenantId: string, workOrderId: string): Promise<void> {
  const wo = await NativeWorkorder.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), workOrderId }).select('status').lean();
  if (!wo) throw new Error(`Work Order "${workOrderId}" was not found`);
  const completedKey = await getOutcomeStageKey(tenantId, 'workorder', 'completed', 'completed');
  if ((wo as any).status !== completedKey) {
    throw new Error(`Work Order "${workOrderId}" has not been completed yet (current status: "${(wo as any).status}") — an invoice can only be created once it's completed`);
  }
}

export async function listInvoices(tenantId: string, opts: InvoiceListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
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
  const dateField = opts.dateField && INVOICE_DATE_FIELDS.has(opts.dateField) ? opts.dateField : 'createdAt';
  applyDateRangeToFilter(filter, dateField, resolveDateRange(opts.range, opts.dateFrom, opts.dateTo));
  if (opts.filters) {
    const catalog = await getInvoiceFilterCatalog(tenantId, branchId);
    applyDynamicFilters(filter, opts.filters, catalog);
  }

  const [items, total] = await Promise.all([
    NativeInvoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeInvoice.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getInvoiceById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const invoice = await NativeInvoice.findOne(filter);
  if (invoice) {
    const receipts = await NativeReceipt.find({
      tenantId: tid,
      $or: [{ invoiceId: invoice.invoiceId }, { invoiceId: String(invoice._id) }],
      status: { $ne: 'refunded' },
    });
    const totalPaid = Math.round(receipts.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) * 100) / 100;
    if (invoice.paidAmount !== totalPaid) {
      invoice.paidAmount = totalPaid;
      const totalDue = Number(invoice.servicesAmountWithTax) || 0;
      invoice.paid = totalDue > 0 && totalPaid >= totalDue;
      if (invoice.paid && invoice.status !== 'paid') {
        invoice.status = 'paid';
      } else if (!invoice.paid && invoice.status === 'paid') {
        invoice.status = 'sent';
      }
      await invoice.save();
    }
  }
  return invoice;
}

export async function createInvoice(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  if (data.workOrderId) await assertWorkOrderCompleted(String(data.tenantId), data.workOrderId);
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  let discount = Number(data.discount ?? 0);
  let gst      = Number(data.gstPercentage ?? 0);

  const hasLineTaxOrDisc = services.some((s: any) => (Number(s.taxPercent) > 0 || Number(s.discountPercent) > 0));
  let servicesAmount: number;
  let servicesAmountWithTax: number;

  if (discount === 0 && gst === 0 && hasLineTaxOrDisc) {
    let lineAfter = 0;
    let lineWithTax = 0;
    for (const s of services) {
      const gross = (Number(s.amount) || 0) * (Number(s.count) || 1);
      const afterD = gross * (1 - (Number(s.discountPercent) || 0) / 100);
      const withT = afterD * (1 + (Number(s.taxPercent) || 0) / 100);
      lineAfter += afterD;
      lineWithTax += withT;
    }
    servicesAmount = Math.round((lineAfter + prtTotal) * 100) / 100;
    servicesAmountWithTax = Math.round((lineWithTax + prtTotal) * 100) / 100;
    const firstDisc = Number(services[0]?.discountPercent || 0);
    const firstTax  = Number(services[0]?.taxPercent || 0);
    if (services.every((s: any) => Number(s.discountPercent || 0) === firstDisc)) {
      data.discount = firstDisc;
    }
    if (services.every((s: any) => Number(s.taxPercent || 0) === firstTax)) {
      data.gstPercentage = firstTax;
    }
  } else {
    // discount is a percentage (0-100), not a flat amount — matches quotation.service.ts.
    const subtotal = svcTotal + prtTotal;
    const after    = subtotal - (subtotal * discount) / 100;
    servicesAmount = Math.round(after * 100) / 100;
    servicesAmountWithTax = Math.round((after + (after * gst) / 100) * 100) / 100;
  }

  const doc = await NativeInvoice.create({
    ...data,
    partsAmount:           prtTotal,
    servicesAmount,
    servicesAmountWithTax,
  });
  const mongoId = (doc._id as any).toString();
  // Independent checks, not if/else-if — same fix and same reason as
  // createWorkorder(): buildPrefill.ts now carries the full ancestor chain
  // forward, so an Invoice created from a WorkOrder can legitimately also
  // carry a quotationId and/or contractId at once, and each one present
  // should be marked complete, not just whichever the old else-if chain
  // reached first.
  if (data.workOrderId) {
    const src = await NativeWorkorder.findOne({ workOrderId: data.workOrderId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'workorder', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  }
  if (data.quotationId) {
    const src = await NativeQuotation.findOne({ quotationId: data.quotationId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  }
  if (data.contractId) {
    const src = await NativeContract.findOne({ contractId: data.contractId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  }
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'invoices', doc.toObject(), (doc as any).invoiceId);
  return doc;
}

export async function updateInvoice(id: string, tenantId: string, data: any, scope?: DataScope) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeInvoice.findOne(filter).lean();
    const services  = data.services        ?? (existing as any)?.services        ?? [];
    const parts     = data.parts           ?? (existing as any)?.parts           ?? [];
    let discount    = Number(data.discount      ?? (existing as any)?.discount      ?? 0);
    let gst         = Number(data.gstPercentage ?? (existing as any)?.gstPercentage ?? 0);
    const svcTotal  = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
    const prtTotal  = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);

    const hasLineTaxOrDisc = services.some((s: any) => (Number(s.taxPercent) > 0 || Number(s.discountPercent) > 0));
    if (discount === 0 && gst === 0 && hasLineTaxOrDisc) {
      let lineAfter = 0;
      let lineWithTax = 0;
      for (const s of services) {
        const gross = (Number(s.amount) || 0) * (Number(s.count) || 1);
        const afterD = gross * (1 - (Number(s.discountPercent) || 0) / 100);
        const withT = afterD * (1 + (Number(s.taxPercent) || 0) / 100);
        lineAfter += afterD;
        lineWithTax += withT;
      }
      data.partsAmount           = prtTotal;
      data.servicesAmount        = Math.round((lineAfter + prtTotal) * 100) / 100;
      data.servicesAmountWithTax = Math.round((lineWithTax + prtTotal) * 100) / 100;
      const firstDisc = Number(services[0]?.discountPercent || 0);
      const firstTax  = Number(services[0]?.taxPercent || 0);
      if (services.every((s: any) => Number(s.discountPercent || 0) === firstDisc)) {
        data.discount = firstDisc;
      }
      if (services.every((s: any) => Number(s.taxPercent || 0) === firstTax)) {
        data.gstPercentage = firstTax;
      }
    } else {
      // discount is a percentage (0-100), not a flat amount — matches createInvoice.
      const subtotal  = svcTotal + prtTotal;
      const after     = subtotal - (subtotal * discount) / 100;
      data.partsAmount           = prtTotal;
      data.servicesAmount        = Math.round(after * 100) / 100;
      data.servicesAmountWithTax = Math.round((after + (after * gst) / 100) * 100) / 100;
    }
  }
  const updated = await NativeInvoice.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'invoices', updated.toObject(), (updated as any).invoiceId);
  return updated;
}

export async function deleteInvoice(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeInvoice.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'invoices', String(deleted._id));
  return deleted;
}
