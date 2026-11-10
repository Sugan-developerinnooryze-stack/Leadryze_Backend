import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { NativeReceipt } from './receipt.model';
import { NativeInvoice } from '../invoices/invoice.model';
import { NativeCustomer } from '../customers/customer.model';
import { ReceiptListOptions } from './receipt.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

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
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { receiptId: id }] }
    : { receiptId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeReceipt.findOne(filter);
}

/** The receipts that count toward an invoice's paid amount: the invoice's own
 * receipts (stored under its business id or its Mongo id), refunds excluded. */
export function invoiceReceiptsFilter(tid: mongoose.Types.ObjectId, invoice: { invoiceId?: string; _id: unknown }) {
  return {
    tenantId: tid,
    $or: [{ invoiceId: invoice.invoiceId }, { invoiceId: String(invoice._id) }],
    status: { $ne: 'refunded' },
  };
}

/** LR-C4-RCPT-004: the payment fields syncInvoicePaidAmount writes, worked out
 * from the invoice and its counted receipts. Pure (no reads, no writes), so
 * the invoice repair script's dry run shows exactly what --apply will change.
 * The logic is the one syncInvoicePaidAmount always had, moved here as is. */
export function computeInvoicePaymentState(
  invoice: { servicesAmountWithTax?: unknown; status?: string; priorStatus?: string },
  receipts: Array<{ amount?: unknown }>,
): { paidAmount: number; paid: boolean; status?: string; priorStatus?: string } {
  const paidAmount = Math.round(receipts.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) * 100) / 100;
  const totalDue = Number(invoice.servicesAmountWithTax) || 0;
  const paid = totalDue > 0 && paidAmount >= totalDue;
  let { status, priorStatus } = invoice;

  // Synchronize invoice stage when payment state changes
  if (paid) {
    if (status !== 'paid') {
      priorStatus = status;
      status = 'paid';
    }
  } else if (status === 'paid') {
    // LR-C3-RCPT-002: Revert to prior status (draft, sent, etc.) instead of hardcoding 'sent'
    status = priorStatus || 'draft';
  }
  return { paidAmount, paid, status, priorStatus };
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
  const receipts = await NativeReceipt.find(invoiceReceiptsFilter(tid, invoice));
  const next = computeInvoicePaymentState(invoice, receipts);
  invoice.paidAmount = next.paidAmount;
  invoice.paid = next.paid;
  if (next.status !== invoice.status) {
    invoice.priorStatus = next.priorStatus;
    invoice.status = next.status as string;
  }
  await invoice.save();
}

// In-flight submission lock to serialize concurrent identical requests (e.g. scripted same-tick double submit)
const inFlightReceipts = new Map<string, Promise<any>>();

// Short duplicate window cache (TTL 5000ms) to guard against quick consecutive double clicks
const duplicateReceiptCache = new Map<string, { receipt: any; expiresAt: number }>();

// LR-C4-RCPT-005: entries were only ever overwritten, never removed, so the
// cache grew without limit; expired ones are dropped as new ones are added.
function rememberRecentReceipt(lockKey: string, receipt: any, ttlMs: number): void {
  const now = Date.now();
  if (duplicateReceiptCache.size > 500) {
    for (const [k, v] of duplicateReceiptCache) if (v.expiresAt <= now) duplicateReceiptCache.delete(k);
  }
  duplicateReceiptCache.set(lockKey, { receipt, expiresAt: now + ttlMs });
}

function getReceiptLockKey(data: any): string {
  return `${data.tenantId}:${data.invoiceId}:${data.customerId}:${Number(data.amount) || 0}`;
}

/** LR-C4-RCPT-005: what a create did. replayed: this payment was already
 * recorded, the receipt returned is that one and no second receipt was made
 * (the same idempotency key and payment details; or, without a key, an
 * identical submission in the same moment or the last 5 seconds). */
export interface ReceiptCreateOutcome { receipt: any; replayed: boolean }

/** The payment details an idempotency key stands for. */
function paymentHash(data: any): string {
  return createHash('sha256').update(JSON.stringify([
    String(data.invoiceId ?? ''), String(data.customerId ?? ''), Number(data.amount) || 0,
    String(data.paymentMethod ?? 'cash'), String(data.paymentDate ?? '').trim(),
  ])).digest('hex');
}

function replayOrConflict(receipt: any, requestHash: string): ReceiptCreateOutcome {
  if (receipt?.requestHash && receipt.requestHash !== requestHash) {
    throw Object.assign(new Error('This idempotency key was already used for a payment with different details'), { statusCode: 409 });
  }
  return { receipt, replayed: true };
}

const isKeyClash = (err: any) =>
  err?.code === 11000 && (Boolean(err?.keyPattern?.idempotencyKey) || /idempotencyKey/.test(String(err?.message ?? '')));

/** The receipt fits its invoice: same customer, a balance left, an amount
 * above 0 and not over the balance (LR-RCPT-002, LR-R2-RCPT-001). */
async function assertReceiptFitsInvoice(data: any): Promise<void> {
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
}

async function saveReceipt(data: any): Promise<any> {
  const created = await NativeReceipt.create(data);
  // Keep invoice paid amount and paid flag in sync
  await syncInvoicePaidAmount(data.invoiceId, data.tenantId);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'receipts', created.toObject(), (created as any).receiptId);
  return created;
}

/** Runs fn once per lockKey at a time in this process: a request arriving
 * while the same key is running gets that run's result (or error). */
async function onceInFlight<T>(lockKey: string, fn: () => Promise<T>): Promise<{ result: T; joined: boolean }> {
  const existingInFlight = inFlightReceipts.get(lockKey);
  if (existingInFlight) return { result: await existingInFlight, joined: true };

  // IMMEDIATELY register the in-flight promise before ANY await to prevent races
  let resolvePromise!: (val: any) => void;
  let rejectPromise!: (err: any) => void;
  const executionPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // LR-R26-RCPT-006: usually no second request awaits this promise, so when
  // the create fails (amount over the balance, amount 0, wrong or unknown
  // invoice, a database error) its rejection had no handler. Node reported an
  // unhandled rejection and server.ts exits on one: a single rejected receipt
  // restarted the backend for every tenant. This handler only marks the
  // rejection as handled; the caller still gets the error from the rethrow
  // below, and a waiting duplicate request still receives the rejection.
  executionPromise.catch(() => {});
  inFlightReceipts.set(lockKey, executionPromise);
  try {
    const result = await fn();
    resolvePromise(result);
    return { result, joined: false };
  } catch (err) {
    rejectPromise(err);
    throw err;
  } finally {
    inFlightReceipts.delete(lockKey);
  }
}

/**
 * LR-C4-RCPT-005: with an idempotency key (the New Receipt form sends one per
 * submission; API callers may send the Idempotency-Key header or the
 * idempotencyKey field), the key decides: the first request with it records
 * the payment and stores the key and a hash of its details; any later request
 * with the key, at any time and on any server, gets that receipt back as a
 * replay, or a 409 if its details differ. A different key is a different
 * payment, even with the same amount at the same moment. The key never got
 * here before (validation dropped it), so payments of the same amount were
 * merged into one and later retries made new receipts.
 */
async function createWithKey(data: any): Promise<ReceiptCreateOutcome> {
  const requestHash = paymentHash(data);
  const keyFilter = { tenantId: data.tenantId, idempotencyKey: data.idempotencyKey };
  const { result, joined } = await onceInFlight(`${data.tenantId}:key:${data.idempotencyKey}`, async (): Promise<ReceiptCreateOutcome> => {
    const existing = await NativeReceipt.findOne(keyFilter);
    if (existing) return replayOrConflict(existing, requestHash);
    await assertReceiptFitsInvoice(data);
    try {
      return { receipt: await saveReceipt({ ...data, requestHash }), replayed: false };
    } catch (err) {
      // Another server recorded this key in the same moment (unique index).
      if (isKeyClash(err)) {
        const winner = await NativeReceipt.findOne(keyFilter);
        if (winner) return replayOrConflict(winner, requestHash);
      }
      throw err;
    }
  });
  return joined ? replayOrConflict(result.receipt, requestHash) : result;
}

/** Without a key: as before, an identical submission (same invoice, customer
 * and amount) in the same moment or the last 5 seconds is taken as a double
 * submit, but it is now reported as a replay of that receipt instead of
 * "Created successfully". Whether such a request should be refused instead
 * is an open decision (LR-C4-RCPT-005). */
async function createWithoutKey(data: any): Promise<ReceiptCreateOutcome> {
  const lockKey = getReceiptLockKey(data);
  const windowMs = 5000;

  // 1. Check in-memory short duplicate cache (synchronous)
  const cached = duplicateReceiptCache.get(lockKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { receipt: cached.receipt, replayed: true };
  }

  // 2. An identical request in flight gets its result
  const { result, joined } = await onceInFlight(lockKey, async (): Promise<ReceiptCreateOutcome> => {
    // Check DB for recent identical receipt within 5 seconds
    const recentCutoff = new Date(Date.now() - windowMs);
    const recentReceipt = await NativeReceipt.findOne({
      tenantId: data.tenantId,
      invoiceId: data.invoiceId,
      customerId: data.customerId,
      amount: Number(data.amount) || 0,
      createdAt: { $gte: recentCutoff },
    }).sort({ createdAt: -1 });

    if (recentReceipt) {
      rememberRecentReceipt(lockKey, recentReceipt, windowMs);
      return { receipt: recentReceipt, replayed: true };
    }

    await assertReceiptFitsInvoice(data);
    const created = await saveReceipt(data);
    rememberRecentReceipt(lockKey, created, windowMs);
    return { receipt: created, replayed: false };
  });
  return joined ? { receipt: result.receipt, replayed: true } : result;
}

export async function createReceiptWithOutcome(data: any): Promise<ReceiptCreateOutcome> {
  const key = typeof data?.idempotencyKey === 'string' ? data.idempotencyKey.trim() : '';
  const { idempotencyKey: _ignored, requestHash: _hash, ...rest } = data ?? {};
  return key ? createWithKey({ ...rest, idempotencyKey: key }) : createWithoutKey(rest);
}

/** The receipt only (callers that do not need to know about replays). */
export async function createReceipt(data: any) {
  return (await createReceiptWithOutcome(data)).receipt;
}

export async function updateReceipt(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { receiptId: id }] }
    : { receiptId: id };
  const filter: any = { ...idFilter, tenantId: tid };
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
    withExpectedVersion(filter, guard),
    data,
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativeReceipt, filter, guard);
  if (updated) {
    await syncInvoicePaidAmount(updated.invoiceId, tenantId);
    if (oldInvoiceId && oldInvoiceId !== updated.invoiceId) {
      await syncInvoicePaidAmount(oldInvoiceId, tenantId);
    }
    indexNativeSearchRecord(tenantId, 'native-crm', 'receipts', updated.toObject(), (updated as any).receiptId);
  }
  return updated;
}

export async function deleteReceipt(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { receiptId: id }] }
    : { receiptId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeReceipt.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeReceipt, filter, guard);
  if (deleted) {
    await syncInvoicePaidAmount(deleted.invoiceId, tenantId);
    removeNativeSearchRecord(tenantId, 'native-crm', 'receipts', String(deleted._id));
  }
  return deleted;
}

