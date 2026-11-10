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
import { computeDocumentTotals } from '../shared/document-totals';
import { getInvoiceFilterCatalog } from './invoice.filter-catalog';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

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
async function assertWorkOrderEligibleForInvoice(
  tenantId: string, workOrderId: string, customerId?: string, allowDuplicate = false,
  opts: { excludeInvoiceId?: unknown; customerOnly?: boolean } = {},
): Promise<void> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const wo = await NativeWorkorder.findOne({ tenantId: tid, workOrderId }).select('status customerId').lean();
  if (!wo) throw new Error(`Work Order "${workOrderId}" was not found`);
  if (customerId && (wo as any).customerId && (wo as any).customerId !== customerId) {
    throw new Error(`Work Order "${workOrderId}" belongs to customer "${(wo as any).customerId}", not "${customerId}"`);
  }
  if (opts.customerOnly) return;
  const completedKey = await getOutcomeStageKey(tenantId, 'workorder', 'completed', 'completed');
  if ((wo as any).status !== completedKey) {
    throw new Error(`Work Order "${workOrderId}" has not been completed yet (current status: "${(wo as any).status}") — an invoice can only be created once it's completed`);
  }
  if (!allowDuplicate) {
    // LR-PL-INV-001: on an edit the invoice itself does not count.
    const existingInv = await NativeInvoice.findOne({
      tenantId: tid,
      workOrderId,
      status: { $ne: CANCELLED_INVOICE },
      ...(opts.excludeInvoiceId ? { _id: { $ne: opts.excludeInvoiceId } } : {}),
    }).select('invoiceId status').lean();
    if (existingInv) {
      throw new Error(`Work Order "${workOrderId}" is already invoiced on invoice "${(existingInv as any).invoiceId}" (status: ${(existingInv as any).status}). Duplicate invoicing requires an explicit override.`);
    }
  }
}

/* LR-PL-INV-001: one active invoice per work order. The check above reads
 * before the invoice is written, so requests arriving together all passed it
 * and all created an invoice (QA: INV-0019, INV-0020 and INV-0021 for
 * WO-0022). The invoice that holds a work order now carries workOrderLock,
 * and a unique index on it (invoice.model.ts) lets the database accept only
 * one; the others get the same "already invoiced" message. */

/** The same text as the check above (crm-assist's mapCreateInvoiceError reads
 * it), for a work order another invoice took at the same moment. */
function alreadyInvoicedMessage(workOrderId: string, inv: { invoiceId?: unknown; status?: unknown } | null | undefined): string {
  return `Work Order "${workOrderId}" is already invoiced on invoice "${inv?.invoiceId ?? 'unknown'}" (status: ${inv?.status ?? 'unknown'}). Duplicate invoicing requires an explicit override.`;
}

/** The stage of a cancelled invoice. The invoice pipeline's Cancelled stage
 * carries no outcome tag a tenant could move to another key, so this is the
 * key the existing check has always used. */
const CANCELLED_INVOICE = 'cancelled';

/** The database refused a second invoice holding the same work order. */
function isWorkOrderLockConflict(err: unknown): boolean {
  const e = err as { code?: unknown; keyPattern?: Record<string, unknown>; message?: unknown } | null;
  return e?.code === 11000 && (!!e.keyPattern?.workOrderLock || /workOrderLock/.test(String(e.message ?? '')));
}

/** The message for a work order another invoice took first. */
async function workOrderTakenError(tenantId: string, workOrderId: string): Promise<Error> {
  const holder = await NativeInvoice.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), workOrderLock: workOrderId })
    .select('invoiceId status').lean();
  return new Error(alreadyInvoicedMessage(workOrderId, holder as any));
}

/** What an edit does to the invoice's hold on its work order. Cancelling it,
 * or removing its work order, releases the hold. Linking another work order,
 * or bringing a cancelled invoice back, checks that work order as a create
 * does (completed, same customer, no other active invoice) and takes the
 * hold. A new customer on an invoice linked to a work order must be that work
 * order's customer. An invoice without a hold (made before the hold existed,
 * or with the duplicate override) keeps it that way on other edits. */
async function planWorkOrderLock(
  tenantId: string,
  current: { _id: unknown; workOrderId?: string; customerId?: string; status?: string; workOrderLock?: string },
  data: { workOrderId?: unknown; customerId?: unknown; status?: unknown },
): Promise<{ set?: string; unset?: true } | undefined> {
  const currentWorkOrder = String(current.workOrderId ?? '').trim();
  const nextWorkOrder = data.workOrderId !== undefined ? String(data.workOrderId ?? '').trim() : currentWorkOrder;
  const nextStatus = data.status !== undefined ? String(data.status) : String(current.status ?? '');
  const nextCustomer = data.customerId !== undefined ? String(data.customerId ?? '') : String(current.customerId ?? '');
  const holding = typeof current.workOrderLock === 'string';

  if (!nextWorkOrder || nextStatus === CANCELLED_INVOICE) return holding ? { unset: true } : undefined;

  const workOrderChanged = nextWorkOrder !== currentWorkOrder;
  const broughtBack = current.status === CANCELLED_INVOICE;
  if (workOrderChanged || broughtBack) {
    await assertWorkOrderEligibleForInvoice(tenantId, nextWorkOrder, nextCustomer || undefined, false, { excludeInvoiceId: current._id });
    return current.workOrderLock === nextWorkOrder ? undefined : { set: nextWorkOrder };
  }
  if (data.customerId !== undefined && nextCustomer !== String(current.customerId ?? '')) {
    await assertWorkOrderEligibleForInvoice(tenantId, nextWorkOrder, nextCustomer || undefined, false, { customerOnly: true });
  }
  return undefined;
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
  const from = (opts.dateFrom || opts.customFrom) as string | undefined;
  const to = (opts.dateTo || opts.customTo) as string | undefined;
  applyDateRangeToFilter(filter, dateField, resolveDateRange(opts.range, from, to));
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
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { invoiceId: id }] }
    : { invoiceId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
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
    }
  }
  return invoice;
}

export async function createInvoice(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  // LR-PL-INV-001: the hold on the work order is set here only, never taken
  // from the caller.
  delete data.workOrderLock;
  let workOrderLock: string | undefined;
  if (data.workOrderId) {
    const allowDuplicate = Boolean(data.allowDuplicateWorkOrderInvoice);
    await assertWorkOrderEligibleForInvoice(
      String(data.tenantId),
      data.workOrderId,
      data.customerId ? String(data.customerId) : undefined,
      allowDuplicate
    );
    if (!allowDuplicate && data.status !== CANCELLED_INVOICE) workOrderLock = String(data.workOrderId).trim();
  }
  // Totals: NC/shared/document-totals.ts (pinned by tests/document-totals-golden.test.ts).
  // discount is a percentage (0-100), not a flat amount — matches quotation.service.ts.
  const t = computeDocumentTotals('invoice', { services: data.services, parts: data.parts, discount: data.discount, gstPercentage: data.gstPercentage });
  if (t.backfill.discount !== undefined) data.discount = t.backfill.discount;
  if (t.backfill.gstPercentage !== undefined) data.gstPercentage = t.backfill.gstPercentage;

  let doc;
  try {
    doc = await NativeInvoice.create({
      ...data,
      ...(workOrderLock ? { workOrderLock } : {}),
      partsAmount:           t.partsAmount,
      servicesAmount:        t.servicesAmount,
      servicesAmountWithTax: t.servicesAmountWithTax,
      priorStatus:           data.status && data.status !== 'paid' ? data.status : 'draft',
    });
  } catch (err) {
    // Another invoice took this work order at the same moment.
    if (workOrderLock && isWorkOrderLockConflict(err)) throw await workOrderTakenError(String(data.tenantId), workOrderLock);
    throw err;
  }
  const mongoId = (doc._id as any).toString();
  // Independent checks, not if/else-if — same fix and same reason as
  // createWorkorder(): buildPrefill.ts now carries the full ancestor chain
  // forward, so an Invoice created from a WorkOrder can legitimately also
  // carry a quotationId and/or contractId at once, and each one present
  // should be marked complete, not just whichever the old else-if chain
  // reached first. Each lookup is scoped to this invoice's own tenant: the
  // source ids come from the caller, and only workOrderId is checked against
  // this tenant above.
  if (data.workOrderId) {
    const src = await NativeWorkorder.findOne({ tenantId: doc.tenantId, workOrderId: data.workOrderId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'workorder', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }, doc.tenantId).catch(() => {});
  }
  if (data.quotationId) {
    const src = await NativeQuotation.findOne({ tenantId: doc.tenantId, quotationId: data.quotationId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }, doc.tenantId).catch(() => {});
  }
  if (data.contractId) {
    const src = await NativeContract.findOne({ tenantId: doc.tenantId, contractId: data.contractId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }, doc.tenantId).catch(() => {});
  }
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'invoices', doc.toObject(), (doc as any).invoiceId);
  return doc;
}

export async function updateInvoice(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { invoiceId: id }] }
    : { invoiceId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (data.status && data.status !== 'paid') {
    data.priorStatus = data.status;
  }
  // LR-PL-INV-001: the hold on a work order changes only as planWorkOrderLock
  // says, never from the caller.
  delete data.workOrderLock;
  let lockChange: { set?: string; unset?: true } | undefined;
  if (data.workOrderId !== undefined || data.customerId !== undefined || data.status !== undefined) {
    const current = await NativeInvoice.findOne(filter).select('_id workOrderId customerId status workOrderLock').lean();
    if (current) lockChange = await planWorkOrderLock(tenantId, current as any, data);
  }
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeInvoice.findOne(filter).lean();
    // Totals: NC/shared/document-totals.ts (pinned by tests/document-totals-golden.test.ts).
    // discount is a percentage (0-100), not a flat amount — matches createInvoice.
    // Number() of discount and GST first, as before the shared function: the same value, and the
    // same error first for a body without the screen's Zod.
    const t = computeDocumentTotals('invoice', {
      services:      data.services      ?? (existing as any)?.services,
      parts:         data.parts         ?? (existing as any)?.parts,
      discount:      Number(data.discount      ?? (existing as any)?.discount      ?? 0),
      gstPercentage: Number(data.gstPercentage ?? (existing as any)?.gstPercentage ?? 0),
    });
    data.partsAmount           = t.partsAmount;
    data.servicesAmount        = t.servicesAmount;
    data.servicesAmountWithTax = t.servicesAmountWithTax;
    if (t.backfill.discount !== undefined) data.discount = t.backfill.discount;
    if (t.backfill.gstPercentage !== undefined) data.gstPercentage = t.backfill.gstPercentage;
  }
  // With a guard, the totals above were computed from `existing`; the
  // version condition makes the write fail if that record changed since.
  const update: Record<string, unknown> = { ...data };
  if (lockChange?.set) update.workOrderLock = lockChange.set;
  if (lockChange?.unset) update.$unset = { workOrderLock: 1 };
  let updated;
  try {
    updated = await NativeInvoice.findOneAndUpdate(
      withExpectedVersion(filter, guard),
      update,
      { new: true, runValidators: true }
    );
  } catch (err) {
    if (lockChange?.set && isWorkOrderLockConflict(err)) throw await workOrderTakenError(tenantId, lockChange.set);
    throw err;
  }
  if (!updated) await throwIfStale(NativeInvoice, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'invoices', updated.toObject(), (updated as any).invoiceId);
  return updated;
}

export async function deleteInvoice(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { invoiceId: id }] }
    : { invoiceId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeInvoice.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeInvoice, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'invoices', String(deleted._id));
  return deleted;
}
