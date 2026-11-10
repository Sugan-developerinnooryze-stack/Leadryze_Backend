import mongoose from 'mongoose';
import type { FormValue } from '../contracts/views';
import type { WriteFormField, WriteLineSpec, WriteManifest } from '../registry/types';
import type { WorkflowSealed } from '../operations/sealed';
import { gateRelated } from '../query/relations';
import { workflowNotice } from '../views/compose-form';
import { normalizeSnapshotValue } from '../../internal/crm-gateway.helpers';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { computeDocumentTotals, screenCents, totalsWithLineRates } from '../../native-crm/shared/document-totals';
import type { DocumentTotals } from '../../native-crm/shared/document-totals';
import { NativeQuotation } from '../../native-crm/quotations/quotation.model';
import { NativeContract } from '../../native-crm/contracts/contract.model';
import { logger } from '../../../utils/logger';
import { checkInvoiceEligibility, existingInvoiceFor, mapCreateInvoiceError } from './invoice-eligibility';
import type { WoSnapshot } from './invoice-eligibility';
import type {
  ApplyContext, CommitLock, SealedLine, SourceSnapshot, SourceStart, SourceStartInput, StoredRefValue, WorkflowModule,
  WriteRuleContext, WriteRuleResult,
} from './workflow-types';

/* The invoice's guided form (Increment 7, spec B6, M15 to M20): its WriteCap
 * (the New Invoice drawer's own fields, with lines priced from the service
 * catalog), its read-only rules, the work order it can be made from, and the
 * hooks Confirm runs around the write. A create writes through createInvoice,
 * so the service's own totals, number, eligibility check, search index and
 * the work order's Converted mark (advanceWorkflow) happen as on the screen.
 * An update changes the address, due date, status, notes and custom fields
 * only, so the service never recomputes a total from chat (M14). A delete is
 * refused with a notice and a link to the Invoices page (D20, M22).
 *
 * Two create modes, chosen at start:
 * - from a work order (intent.from; source): the work order's lines, discount,
 *   GST, notes and address as the screen's Create Invoice copies them, after
 *   the eligibility pre-check (invoice-eligibility.ts). The customer and the
 *   lines are fixed; the write also carries workOrderId and the work order's
 *   quotationId and contractId. Confirm holds a lock per work order number
 *   (locks.ts) around the re-check and the write;
 * - standalone: a customer the caller picks, and catalog lines.
 *
 * The rules only read (peekStages, never the stage functions that can write
 * before Confirm). They add the per-line tax note and the totals a re-save,
 * the print page and the PDF would show when they differ from this one (M6),
 * the work order re-checks at review and Confirm, and the update rules: a
 * paid invoice keeps its status, cancelling warns, notes formatted on the
 * invoice page, past and emptied due dates. */

/* ── Texts (spec B12, lead notes C14 to C16) ── */
const INVOICE_DELETE_REFUSED = "Invoices can't be deleted from the assistant. Open the invoice to delete it on its page.";
const INVOICE_ADDRESS_HIDDEN = "This customer's address is hidden for your role. Type the billing address.";
const INVOICE_NUMBER_LINE = 'An invoice number is assigned when it is saved.';
const TIMELINE_LINE = 'The record timeline and search are updated, as when you save on the screen.';
const INVOICE_PRICES_BLOCKED = "Prices come from your service catalog. To change a price or add a line that isn't in the catalog, use the invoice page.";
const PAYMENTS_BLOCKED = "Payments are recorded as receipts. The paid status can't be set here.";
const INVOICE_MONEY_BLOCKED = 'Lines, discount and GST of an existing invoice are changed on the invoice page.';
const LINE_MODE_WILL = "Tax and discount are worked out per line, from the work order's lines.";
const DUE_PASSED = 'This due date has already passed. Scheduled reminders may message the customer about it.';
const CANCELLED_ON_CREATE = "A cancelled invoice doesn't count as invoicing its work order.";
const PAID_STATUS_LOCKED = "Payments set this invoice's status. Change it on the invoice page.";
const CANCEL_PAYMENTS = "This invoice has payments recorded. Cancelling it doesn't refund them.";
const NOTES_FORMATTING = 'These notes have formatting from the invoice page. Changing them here replaces it with plain text.';
const DATE_CANT_EMPTY = "This date can't be emptied here.";
const MAPPED_INVOICED_HIDDEN = 'This work order has already been invoiced. Nothing was changed.';
const RACE_HIDDEN = 'Another invoice for this work order was created at the same time. Ask an administrator to check it.';
const customerFromSource = (wo: string) => `From ${wo}.`;
const customerFromSourceHidden = (wo: string, customer: string) => `From ${wo}: customer ${customer}. This customer is hidden for your role.`;
const linkedConverted = (number: string) => `${number} will show as Converted.`;
const woNoLines = (wo: string) => `${wo} has no service or part lines, so this invoice totals 0.`;
const woGone = (wo: string) => `${wo} no longer exists, or you can no longer see it.`;
const woChanged = (wo: string) => `${wo} changed since this form was opened. Cancel it and ask again.`;
const resaveChanges = (money: string) => `Saving this invoice again from the Invoices page will change its total to ${money}.`;
const printDiffers = (money: string) => `The printed invoice and its PDF will show ${money}, because they don't use per-line rates.`;
const printPageDiffers = (money: string) => `The printed invoice will show ${money}, because it doesn't use per-line rates.`;
const pdfDiffers = (money: string) => `The invoice PDF will show ${money}, because it doesn't use per-line rates.`;
const headerRatesSaved = (discount: number, gst: number) =>
  `This invoice is saved with Discount % ${discount} and GST % ${gst}, the rates its lines share.`;
const cancelReinvoice = (wo: string) => `${wo} could be invoiced again, and it still shows as Converted.`;
const lockBusy = (wo: string) => `Another invoice for ${wo} is being created right now. Nothing was changed. Try again in a moment.`;
const mappedInvoicedVisible = (wo: string, inv: string, label: string) => `${wo} is already invoiced on ${inv} (${label}). Nothing was changed.`;
const mappedNotCompleted = (wo: string) => `${wo} isn't completed any more. Nothing was changed.`;
const mappedOtherCustomer = (wo: string) => `${wo} now belongs to another customer. Nothing was changed. Review the invoice again.`;
const mappedWoGone = (wo: string) => `${wo} no longer exists, or you can no longer see it. Nothing was changed.`;
const resultConverted = (numbers: string) => `${numbers} will show as Converted.`;
const raceVisible = (inv: string, wo: string) => `${inv} was also created for ${wo} at the same time. One of them should be cancelled.`;

const OPS = ['create', 'update'] as const;
const CREATE_ONLY = ['create'] as const;

const FIELDS: readonly WriteFormField[] = [
  // Standalone: picked or named; from a work order: the work order's, fixed (source.fixedKeys).
  {
    key: 'customerId', label: 'Customer', kind: 'ref', ops: CREATE_ONLY, required: true, group: 'Details',
    ref: { module: 'customer', store: 'business', targetField: 'customerId' }, plannerFillable: false,
  },
  // Required on the drawer. The work order's address, else the customer's for customer-PII viewers (D29, L29).
  { key: 'address', label: 'Address', kind: 'longtext', ops: OPS, required: true, group: 'Details', maxLength: 2000, refuseMasked: true, plannerFillable: false },
  // Create only (M14): an update that sends either makes updateInvoice recompute the totals from the stored lines.
  // From a work order they start as the work order's, not the Field Service defaults (the screen's convert).
  { key: 'discount', label: 'Discount %', kind: 'percent', ops: CREATE_ONLY, required: false, group: 'Money', default: { kind: 'fs_discount' }, plannerFillable: false },
  { key: 'gstPercentage', label: 'GST %', kind: 'percent', ops: CREATE_ONLY, required: false, group: 'Money', default: { kind: 'fs_gst' }, plannerFillable: false },
  { key: 'dueDate', label: 'Due date', kind: 'date', ops: OPS, required: false, group: 'Details', future: true, plannerFillable: true },
  // Receipts set the paid stage (receipt.service.ts syncInvoicePaidAmount): never an option here.
  {
    key: 'status', label: 'Status', kind: 'stage', ops: OPS, required: false, group: 'Details',
    options: { from: 'pipeline', pipeline: 'invoice' }, default: { kind: 'stage', preferred: 'draft' },
    stageExclude: { outcomes: ['paid'], keys: ['paid'] }, plannerFillable: true,
  },
  { key: 'notes', label: 'Notes', kind: 'longtext', ops: OPS, required: false, group: 'Notes', plannerFillable: true },
];

/** Never written from the chat form: the totals createInvoice works out, payments, the links a work order gives
 * (the source writes them, B5.4), the duplicate override, the terms, the document-chain state, the portal token,
 * the numbers, the lock, and the branch and creator, which come from the identity. services and parts are not
 * listed: they are written only through the form's lines. */
const PRIVILEGED: readonly string[] = [
  'partsAmount', 'servicesAmount', 'servicesAmountWithTax', 'paid', 'paidAmount', 'balanceDue', 'priorStatus', 'workOrderId',
  'quotationId', 'contractId', 'allowDuplicateWorkOrderInvoice', 'termsAndConditions', 'workflowState', 'portalToken', 'invoiceId',
  'numId', 'clientId', 'branchId', 'createdBy', 'isLocked', 'lockedAt', 'lockedBy', 'lockReason',
];

const MANIFEST: WriteManifest = {
  will: { create: [INVOICE_NUMBER_LINE, TIMELINE_LINE], update: [TIMELINE_LINE] },
  blocked: { create: [INVOICE_PRICES_BLOCKED, PAYMENTS_BLOCKED], update: [INVOICE_MONEY_BLOCKED, PAYMENTS_BLOCKED] },
};

/** Catalog services only, as the drawer adds them (M8); a standalone create needs one (M11); at most 50 rows
 * (M10); createInvoice's own totals. */
const LINES: WriteLineSpec = { add: ['service'], required: true, max: 50, totals: 'invoice' };

const textOf = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
/** Stored notes the print page wrote as rich text. */
const HTML_TAG = /<[a-z][^>]*>/i;

function noFindings(): WriteRuleResult {
  return { fieldErrors: {}, formErrors: [], warnings: [], sideEffects: [] };
}

function andList(parts: readonly string[]): string {
  return parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ── From a work order (source) ── */

/** The quotation and contract numbers the work order carries that createInvoice will mark Converted: each read by
 * its number tenant-wide as advanceWorkflow reads it (the first match), so only a number exactly one record holds
 * is named (C14, W7). The work order itself always is (eligibility refused a shared number). */
async function linkedOf(tenantId: string, wo: WoSnapshot): Promise<SourceSnapshot['linked']> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [quotations, contracts] = await Promise.all([
    wo.quotationId ? NativeQuotation.countDocuments({ tenantId: tid, quotationId: wo.quotationId }) : 0,
    wo.contractId ? NativeContract.countDocuments({ tenantId: tid, contractId: wo.contractId }) : 0,
  ]);
  return [
    { module: 'workorder', number: wo.number },
    ...(wo.quotationId && quotations === 1 ? [{ module: 'quotation', number: wo.quotationId }] : []),
    ...(wo.contractId && contracts === 1 ? [{ module: 'contract', number: wo.contractId }] : []),
  ];
}

/** An invoice made from a work order (spec B6.2): the pre-check, then what the form starts with. The values are
 * the work order's, as the screen's Create Invoice copies them; the lines are its rows, read-only. */
async function startFromWorkorder(input: SourceStartInput): Promise<SourceStart> {
  const { intent, from, focus, identity, tenant, gate } = input;
  const found = await checkInvoiceEligibility({ from, focus, intent, identity, tenant, gate });
  if (!found.ok) {
    if (found.code === 'wo_ambiguous') return { ok: false, reply: found.reply };
    return { ok: false, reply: { kind: 'notice', notice: workflowNotice('not_eligible', found.text, 'warning', found.href) } };
  }
  const { wo, digest } = found;
  const fixed: Record<string, unknown> = { customerId: wo.customerKey, workOrderId: wo.number };
  // As the screen stores them: a reference the work order holds as text, '' included (W7).
  if (typeof wo.quotationId === 'string') fixed.quotationId = wo.quotationId;
  if (typeof wo.contractId === 'string') fixed.contractId = wo.contractId;
  const countOf = (line: Record<string, unknown>) => (typeof line.count === 'number' ? line.count : 1);
  const lines: SealedLine[] = [
    ...wo.services.map((line, i): SealedLine => ({ key: `s${i}`, kind: 'service', origin: 'source', qty: countOf(line), line })),
    ...wo.parts.map((line, i): SealedLine => ({ key: `p${i}`, kind: 'part', origin: 'source', qty: countOf(line), line })),
  ];
  const form: Record<string, FormValue> = {};
  const refs: Record<string, StoredRefValue> = {};
  const hints: Record<string, string> = {};
  if (wo.customer) {
    form.customerId = { ref: wo.customer.id, label: wo.customer.label };
    refs.customerId = wo.customer;
    hints.customerId = customerFromSource(wo.number);
  } else {
    // The customer the caller can't see is shown by its number only; the write still takes the work order's.
    hints.customerId = customerFromSourceHidden(wo.number, wo.customerKey);
  }
  if (wo.address.trim()) form.address = wo.address;
  // No customer address can be read for this caller, so the address is typed (the lifecycle's prefill doesn't run).
  else if (!wo.customer) hints.address = INVOICE_ADDRESS_HIDDEN;
  form.discount = wo.discount;
  form.gstPercentage = wo.gstPercentage;
  if (wo.notes.trim()) form.notes = wo.notes;
  return {
    ok: true,
    from: {
      module: 'workorder', id: wo.id, number: wo.number, digest, fixedKeys: ['customerId'], fixed,
      linked: await linkedOf(identity.tenantId, wo),
    },
    lines, form, refs, hints, warnings: [],
  };
}

/* ── Confirm hooks (spec B6.4, B6.6) ── */

/** Two Confirms of invoices from the same work order never run their re-check and write together (M18). */
function commitLock(sealed: WorkflowSealed, tenantId: string): CommitLock | null {
  const from = sealed.source.from;
  return from ? { key: { tenantId, kind: 'invoice_from_wo', key: from.number }, busy: lockBusy(from.number) } : null;
}

/** createInvoice's eligibility refusal at Confirm, as the caller may read it (M17): the other invoice is named only
 * when they can see it, the other customer never. Null, with nothing read, for a standalone invoice or any other
 * message (C18): Confirm then gives the generic text. */
async function mapWriteError(input: ApplyContext & { message: string }): Promise<string | null> {
  const from = input.sealed.source.from;
  if (!from) return null;
  const code = mapCreateInvoiceError(input.message);
  const wo = from.number;
  switch (code) {
    case 'already_invoiced': {
      const gate = gateRelated({ identity: input.identity, tenant: input.tenant, now: input.now });
      const { visible } = await existingInvoiceFor(input.identity.tenantId, wo, gate);
      return visible ? mappedInvoicedVisible(wo, visible.number, visible.statusLabel) : MAPPED_INVOICED_HIDDEN;
    }
    case 'not_completed': return mappedNotCompleted(wo);
    case 'other_customer': return mappedOtherCustomer(wo);
    case 'wo_not_found': return mappedWoGone(wo);
    default: return null;
  }
}

/** After an invoice from a work order is created: what createInvoice marks Converted (its advanceWorkflow runs
 * after the write, so "will show"), and another invoice for the same work order that a screen created at the same
 * time (the screen takes no lock). Nothing is ever cancelled. */
async function afterApply(input: ApplyContext & { recordId: string; number?: string }): Promise<string | null> {
  const from = input.sealed.source.from;
  if (!from) return null;
  const numbers = from.linked.map((l) => l.number).filter(Boolean);
  const said = numbers.length ? [resultConverted(andList(numbers))] : [];
  const tenantId = input.identity.tenantId;
  try {
    const gate = gateRelated({ identity: input.identity, tenant: input.tenant, now: input.now });
    const others = await existingInvoiceFor(tenantId, from.number, gate, input.recordId);
    if (others.count > 0) said.push(others.visible ? raceVisible(others.visible.number, from.number) : RACE_HIDDEN);
  } catch {
    // The invoice is saved either way; the Converted sentence still stands. Ids only.
    logger.warn('CRM assist: invoices made at the same time could not be counted', { tenantId, module: 'invoice', recordId: input.recordId });
  }
  return said.length ? said.join(' ') : null;
}

/* ── Rules (read-only) ── */

/** Whether this update changes `key`, compared as the review compares it (operations/diff.ts): a day and its stored
 * instant alike, every empty value alike. */
function changes(input: WriteRuleContext, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input.values, key)
    && normalizeSnapshotValue(input.values[key]) !== normalizeSnapshotValue(input.record?.[key]);
}

/** Money as a server-written sentence shows it (A7): "INR 2196.57". */
function moneyText(currency: string | null, amount: number): string {
  return `${currency ?? 'INR'} ${screenCents(amount).toFixed(2)}`;
}

/** A line as the write sends it (after the screen's Zod). */
interface MoneyLine { amount?: number; count?: number; taxPercent?: number; discountPercent?: number }
type LineList = readonly MoneyLine[];
const linesOf = (value: unknown): LineList => (Array.isArray(value) ? value : []);

/** The total the built-in invoice PDF prints (pdf.templates.ts totalsHtml): the header discount and GST over the
 * services and parts, whatever the lines' own rates. */
function pdfTotal(services: LineList, parts: LineList, disc: number, gst: number): number {
  // LR-R26-CTR-007: the PDF now works lines with their own rates out per line
  // (each at its own rate, else the header's; parts at the header's).
  if (services.some((s) => Number(s.taxPercent) > 0 || Number(s.discountPercent) > 0)) {
    // Rounded once to the cent, as the saved total and the PDF are.
    return Math.round(totalsWithLineRates(services as any[], parts as any[], { discount: disc, gstPercentage: gst }).withTax * 100) / 100;
  }
  const svc = services.reduce((s: number, x) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const prt = parts.reduce((s: number, x) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const raw = svc + prt;
  const discAmt = raw * (disc / 100);
  const sub = raw - discAmt;
  return sub + sub * (gst / 100);
}

/** The total the invoice print page shows (InvoicePrintPage.tsx): the same header-only sum, worked out its own way
 * (C16: the two can differ by a cent). */
function printPageTotal(services: LineList, parts: LineList, discount: number, gst: number): number {
  const svcSubtotal = services.reduce((s: number, sv) => s + (sv.amount ?? 0) * (sv.count ?? 1), 0);
  const prtSubtotal = parts.reduce((s: number, pt) => s + (pt.amount ?? 0) * (pt.count ?? 1), 0);
  const combined = svcSubtotal + prtSubtotal;
  const discountAmt = (combined * discount) / 100;
  const afterDiscount = combined - discountAmt;
  return afterDiscount * (1 + gst / 100);
}

/** Totals the rules can speak about: worked out (C3) and finite (C17). */
function usableTotals(t: DocumentTotals | null | undefined): DocumentTotals | null {
  return t && [t.servicesAmountWithTax, t.servicesAmount, t.partsAmount, t.linesGross].every(Number.isFinite) ? t : null;
}

/** What the totals mean on a create (M6, spec B6.5, C15, C16). Header mode ignores the lines' own rates. Line
 * mode (only a work order's rated lines under a 0/0 header reach it) taxes per line, and createInvoice then saves
 * the rates every line shares as the header's: a re-save from the Invoices page, the print page and the PDF all
 * work from that header, so each total that differs from this one is named. */
function totalsFindings(input: WriteRuleContext, t: DocumentTotals, out: WriteRuleResult): void {
  const { values, mode, ctx } = input;
  const services = linesOf(values.services);
  const parts = linesOf(values.parts);
  // LR-R26-CTR-007: header mode now means no line has its own rate (a header
  // rate with rated lines is mixed mode: each line at its own rate, else the
  // header's), so it has nothing to say; mixed mode is worked out per line.
  if (t.mode === 'header') return;
  out.sideEffects.push({ kind: 'will', text: LINE_MODE_WILL });
  // The header createInvoice stores: the rate every line shares (the back-fill), else what the form sends.
  const discount = t.backfill.discount ?? Number(values.discount ?? 0);
  const gst = t.backfill.gstPercentage ?? Number(values.gstPercentage ?? 0);
  const total = screenCents(t.servicesAmountWithTax);
  const named = (amount: number) => Number.isFinite(amount) && screenCents(amount) !== total;
  const backfilled = t.backfill.discount !== undefined || t.backfill.gstPercentage !== undefined;
  if (backfilled) {
    const resaved = computeDocumentTotals('invoice', { services: values.services, parts: values.parts, discount, gstPercentage: gst });
    if (named(resaved.servicesAmountWithTax)) out.warnings.push(resaveChanges(moneyText(ctx.branchCurrency, resaved.servicesAmountWithTax)));
  }
  const page = printPageTotal(services, parts, discount, gst);
  const pdf = pdfTotal(services, parts, discount, gst);
  if (screenCents(page) === screenCents(pdf)) {
    if (named(pdf)) out.warnings.push(printDiffers(moneyText(ctx.branchCurrency, pdf)));
  } else {
    if (named(page)) out.warnings.push(printPageDiffers(moneyText(ctx.branchCurrency, page)));
    if (named(pdf)) out.warnings.push(pdfDiffers(moneyText(ctx.branchCurrency, pdf)));
  }
  // Review only (the draft's warnings stay as they were): the header the invoice is saved with, when it isn't the typed one.
  const differs = (backfill: number | undefined, typed: unknown) => backfill !== undefined && backfill !== Number(typed ?? 0);
  if (mode === 'review' && (differs(t.backfill.discount, values.discount) || differs(t.backfill.gstPercentage, values.gstPercentage))) {
    out.warnings.push(headerRatesSaved(discount, gst));
  }
}

/** A create from a work order (spec B6.5): what it marks Converted, no lines, and at review and Confirm the work
 * order again: still eligible, and unchanged since start. */
async function sourceFindings(input: WriteRuleContext, source: SourceSnapshot, out: WriteRuleResult): Promise<void> {
  for (const { number } of source.linked) if (number) out.sideEffects.push({ kind: 'linked', text: linkedConverted(number) });
  if (!(input.lines ?? []).length) out.warnings.push(woNoLines(source.number));
  if (input.mode === 'draft') return;
  const from = { module: 'workorder', ref: source.id };
  const found = await checkInvoiceEligibility({
    from, focus: null, intent: { v: 1, op: 'create', module: 'invoice', from }, identity: input.identity, tenant: input.tenant, gate: input.related,
  });
  if (!found.ok) out.formErrors.push(found.code === 'wo_not_found' || found.code === 'wo_ambiguous' ? woGone(source.number) : found.text);
  else if (found.digest !== source.digest || found.wo.number !== source.number) out.formErrors.push(woChanged(source.number));
}

async function checkCreate(input: WriteRuleContext, out: WriteRuleResult): Promise<void> {
  const { values, ctx } = input;
  const totals = usableTotals(input.totals);
  if (totals) totalsFindings(input, totals, out);
  const due = textOf(values.dueDate).trim();
  if (due && due < ctx.todayKey) out.warnings.push(DUE_PASSED);
  // createInvoice's duplicate check skips cancelled invoices (the literal 'cancelled').
  if (textOf(values.status) === 'cancelled') out.warnings.push(CANCELLED_ON_CREATE);
  if (input.source) await sourceFindings(input, input.source, out);
}

/** A paid invoice: receipts set it paid (the flag, or the stage tagged paid, read with peekStages, else 'paid'). */
async function isPaid(tenantId: string, record: Readonly<Record<string, unknown>> | null): Promise<boolean> {
  if (!record) return false;
  if (record.paid === true) return true;
  const status = textOf(record.status);
  if (!status) return false;
  if (status === 'paid') return true;
  const stages = await peekStages(tenantId, 'invoice');
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  return status === stages.find((s) => s.outcome === 'paid' && s.isActive !== false)?.key;
}

async function checkUpdate(input: WriteRuleContext, out: WriteRuleResult): Promise<void> {
  const { values, record, ctx } = input;
  if (changes(input, 'status')) {
    if (await isPaid(input.identity.tenantId, record)) {
      out.fieldErrors.status = PAID_STATUS_LOCKED;
    } else if (textOf(values.status) === 'cancelled') {
      // The duplicate check skips a cancelled invoice, and advanceWorkflow's Converted mark stays on the work order.
      const wo = textOf(record?.workOrderId).trim();
      if (wo) out.warnings.push(cancelReinvoice(wo));
      if (Number(record?.paidAmount) > 0) out.warnings.push(CANCEL_PAYMENTS);
    }
  }
  if (changes(input, 'notes') && HTML_TAG.test(textOf(record?.notes))) out.warnings.push(NOTES_FORMATTING);
  if (changes(input, 'dueDate')) {
    const due = textOf(values.dueDate).trim();
    if (!due) out.fieldErrors.dueDate = DATE_CANT_EMPTY;
    else if (due < ctx.todayKey) out.warnings.push(DUE_PASSED);
  }
}

async function check(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  // A delete never gets here: it is refused before any form (cap.refused).
  if (input.op === 'create') await checkCreate(input, out);
  else if (input.op === 'update') await checkUpdate(input, out);
  return out;
}

export const INVOICE_WORKFLOW: WorkflowModule = {
  cap: {
    module: 'invoice',
    ops: ['create', 'update'],
    refused: { delete: INVOICE_DELETE_REFUSED },
    versionToken: 'compare_and_set',
    fields: FIELDS,
    customFields: true,
    privilegedFields: PRIVILEGED,
    manifest: MANIFEST,
    forRef: 'customerId',
    lines: LINES,
  },
  rules: { check },
  source: { module: 'workorder', start: startFromWorkorder },
  commitLock,
  mapWriteError,
  afterApply,
};
