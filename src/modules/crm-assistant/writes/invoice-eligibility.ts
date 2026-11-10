import { createHash } from 'crypto';
import mongoose from 'mongoose';
import type { WriteIntent } from '../contracts/plan';
import { recordLinkFor } from '../contracts/routes';
import { LINE_CAPS } from '../contracts/views';
import type { AppLink } from '../contracts/views';
import type { GatewayTenant } from '../gates';
import type { AssistIdentity } from '../identity';
import type { RelatedGate, RelatedGateResult } from '../query/relations';
import { MAX_ENTITY_MATCHES, recentEntities, resolveEntity } from '../query/resolve-entity';
import type { EntityMatch } from '../query/resolve-entity';
import { ScopeFailClosedError, idCondition, isObjectIdText, scopedFind, scopedFindById } from '../query/scoped-match';
import { businessNumberOf } from '../query/validate';
import type { ModuleCap } from '../registry/types';
import { looksMasked } from '../operations/validate';
import { composeTargetChoices } from '../views/compose-form';
import type { ComposedAnswer } from '../views/compose';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import type { IPipelineStage } from '../../native-crm/pipeline-config/pipeline-config.model';
import { workorderToInvoicePrefill } from '../../native-crm/shared/document-prefill';
import { NativeWorkorder } from '../../native-crm/workorders/workorder.model';
import { NativeInvoice } from '../../native-crm/invoices/invoice.model';
import type { StoredRef, WorkflowReply } from './workflow-types';

/* Whether a work order may be invoiced from the chat (Increment 7, spec B6.3,
 * M17): a read-only, scoped and redacted pre-check that runs before any
 * draft, and again at review and Confirm. It reads stages with peekStages
 * only (never getOutcomeStageKey, isValidStageKey or getOrCreateStages),
 * names an existing invoice only when the caller can see it, and maps
 * createInvoice's own messages at Confirm to the same scoped texts.
 *
 * The work order is read under its own gate, scope and branch, so another
 * tenant's work order, one out of the caller's scope and one that doesn't
 * exist all read the same. What the invoice copies is taken from the record
 * as the screen's Create Invoice sees it: the API's JSON of the hydrated
 * document, every line with its schema defaults (C13), through the server
 * port of the screen's prefill (document-prefill.ts). Not checked, on
 * purpose: the work order's lock (a locked completed work order is invoiced
 * on the screen too), its branch (the invoice takes the caller's) and the
 * Field Service workflowSteps order (M16). */

/* ── Texts (spec B12, lead notes C14) ── */
const WO_FROM_WRONG_MODULE = 'An invoice can only be made from a work order here.';
const WO_GATE_REFUSED = "You can't look up work orders here.";
const WO_NOT_FOUND_GENERIC = "I couldn't find that work order among the work orders you can see.";
const WO_NO_FOCUS = 'Open the work order on its page, or name it by its number.';
const WO_INVOICED_HIDDEN = 'This work order has already been invoiced.';
const WO_NO_CUSTOMER = "This work order has no customer, so it can't be invoiced here.";
const woNotFound = (number: string) => `I couldn't find work order ${number} among the work orders you can see.`;
const woNotCompleted = (wo: string, label: string) =>
  `${wo} isn't completed yet (its status is ${label}). An invoice can be made once it's completed.`;
const woInvoicedVisible = (wo: string, inv: string, label: string) => `${wo} is already invoiced on ${inv} (${label}).`;
const woNumberShared = (wo: string) => `${wo} can't be invoiced from the assistant. Use Create Invoice on its page.`;
const woTooManyLines = (wo: string) =>
  `${wo} has more than ${LINE_CAPS.rows} lines, so it can't be invoiced here. Use Create Invoice on its page.`;
const woLinesUncopyable = (wo: string) => `${wo} has lines the assistant can't copy. Use Create Invoice on its page.`;

/** A number typed into a sentence: one space between words, at most this many characters. */
const MAX_NUMBER_TEXT = 80;

export interface WoSnapshot {
  id: string; number: string; title: string; status: string; statusLabel: string;
  /** The customer's business id as the work order stores it; `customer` null when the caller can't see it. */
  customerKey: string; customer: StoredRef | null;
  /** '' when empty or masked-looking. */
  address: string;
  services: Array<Record<string, unknown>>; parts: Array<Record<string, unknown>>;
  /** buildPrefill's chains (document-prefill.ts). */
  discount: number; gstPercentage: number; notes: string; quotationId?: string; contractId?: string;
}
/** wo_number_shared (lead notes C14): createInvoice reads the work order by its number tenant-wide and takes the
 * first, so a number two work orders hold can't be invoiced from the chat. */
export type EligibilityRefusal = 'wrong_module' | 'wo_module' | 'wo_not_found' | 'wo_number_shared' | 'not_completed'
  | 'already_invoiced' | 'no_customer' | 'too_many_lines' | 'lines_uncopyable';
export type Eligibility =
  | { ok: true; wo: WoSnapshot; digest: string }
  | { ok: false; code: EligibilityRefusal; text: string; href?: AppLink }
  | { ok: false; code: 'wo_ambiguous'; reply: WorkflowReply };

interface EligibilityInput {
  from: NonNullable<WriteIntent['from']>; focus: { module: string; id: string } | null; intent: WriteIntent;
  identity: AssistIdentity; tenant: GatewayTenant; gate: RelatedGate;
}
type Refusal = Extract<Eligibility, { text: string }>;
type GateOk = Extract<RelatedGateResult, { ok: true }>;
/** The work order as stored (lean), or why there is none to invoice. */
type Found = { row: Record<string, unknown> } | Exclude<Eligibility, { ok: true }>;

function refusal(code: EligibilityRefusal, text: string, href?: AppLink): Refusal {
  return { ok: false, code, text, ...(href ? { href } : {}) };
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const listOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []);

/** A stored _id as lower-case hex text; '' when it is none. */
function hexOf(value: unknown): string {
  const text = typeof value === 'string' ? value : value && typeof value === 'object' ? String(value) : '';
  return isObjectIdText(text) ? text.toLowerCase() : '';
}

/** A number as typed, for a sentence: one space between words, trimmed and clipped. */
function typedNumber(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_NUMBER_TEXT);
}

/** The stage createInvoice counts as completed (getOutcomeStageKey 'completed', else 'completed'), from stages
 * read with peekStages. */
function completedKeyIn(stages: readonly IPipelineStage[]): string {
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  return stages.find((s) => s.outcome === 'completed' && s.isActive !== false)?.key ?? 'completed';
}

function stageLabel(stages: readonly IPipelineStage[], key: string): string {
  return stages.find((s) => s.key === key)?.label?.trim() || key;
}

/** The work order stage createInvoice counts as completed, read without writing (peekStages; never
 * getOutcomeStageKey, which creates the pipeline on its first read). */
export async function completedKeyOf(tenantId: string): Promise<string> {
  return completedKeyIn(await peekStages(tenantId, 'workorder'));
}

/** The invoices of a work order number that aren't cancelled, counted tenant-wide as createInvoice counts them
 * (the literal 'cancelled'), and the newest of them when the caller can see it under the invoice module's gates,
 * scope and branch. `exceptId` leaves one invoice out (the one just created). A refused invoice gate, or a scope
 * that builds nothing (C18), names no invoice: the count only. */
export async function existingInvoiceFor(tenantId: string, woNumber: string, gate: RelatedGate, exceptId?: string):
  Promise<{ count: number; visible?: { id: string; number: string; statusLabel: string } }> {
  const except = exceptId && isObjectIdText(exceptId) ? exceptId : null;
  const count = await NativeInvoice.countDocuments({
    tenantId: new mongoose.Types.ObjectId(tenantId), workOrderId: woNumber, status: { $ne: 'cancelled' },
    ...(except ? { _id: { $ne: new mongoose.Types.ObjectId(except) } } : {}),
  });
  if (!(count > 0)) return { count: 0 };
  const side = await gate('invoice');
  if (!side.ok) return { count };
  let rows: Record<string, unknown>[];
  try {
    rows = await scopedFind(side.cap, side.ctx, [
      { workOrderId: woNumber }, { status: { $ne: 'cancelled' } }, ...(except ? [idCondition('_id', [except], 'nin')] : []),
    ], { sort: { createdAt: -1, _id: -1 }, skip: 0, limit: 1 });
  } catch (err) {
    if (err instanceof ScopeFailClosedError) return { count };
    throw err;
  }
  const row = rows[0];
  const id = hexOf(row?._id);
  const number = textOf(row?.invoiceId).trim();
  // Never an invoice without its number (an id is never shown).
  if (!row || !id || !number) return { count };
  const stages = await peekStages(tenantId, 'invoice');
  return { count, visible: { id, number, statusLabel: stageLabel(stages, textOf(row.status) || 'draft') } };
}

/** The work order the request names, read under the work order gate: by _id, by number (as the lifecycle's
 * pickTarget reads one) or as the record on screen. A scope that builds nothing sees none. */
async function readWorkorder(input: EligibilityInput, side: GateOk): Promise<Found> {
  const { from, focus } = input;
  const rowOr = (row: Record<string, unknown> | null, text: string): Found => (row ? { row } : refusal('wo_not_found', text));
  try {
    if ('ref' in from) return rowOr(await scopedFindById(side.cap, side.ctx, from.ref), WO_NOT_FOUND_GENERIC);
    if ('number' in from) return await readByNumber(input, side, from.number);
    if (!focus || focus.module !== 'workorder') return refusal('wo_not_found', WO_NO_FOCUS);
    return rowOr(await scopedFindById(side.cap, side.ctx, focus.id), WO_NOT_FOUND_GENERIC);
  } catch (err) {
    if (!(err instanceof ScopeFailClosedError)) throw err;
    return refusal('wo_not_found', 'number' in from && typedNumber(from.number) ? woNotFound(typedNumber(from.number)) : WO_NOT_FOUND_GENERIC);
  }
}

/** Work order numbers aren't unique (no index). The matches carrying the number (case aside): one is read; two
 * carrying the identical number can't be invoiced here (C14); numbers that differ only by case are offered as a
 * choice, each starting the same invoice from that work order. */
async function readByNumber(input: EligibilityInput, side: GateOk, asked: string): Promise<Found> {
  const typed = typedNumber(asked);
  if (!typed) return refusal('wo_not_found', WO_NOT_FOUND_GENERIC);
  const found = await resolveEntity(side.cap, { text: typed }, side.ctx, { limit: MAX_ENTITY_MATCHES });
  const want = (businessNumberOf(typed)?.number ?? typed).toUpperCase();
  const numbered = found.matches.filter((m) => m.number?.toUpperCase() === want);
  if (!numbered.length) return refusal('wo_not_found', woNotFound(typed));
  if (numbered.length > 1) {
    const shared = numbered.find((m, i) => numbered.some((other, j) => j !== i && other.number === m.number));
    if (shared?.number) return refusal('wo_number_shared', woNumberShared(shared.number));
    return {
      ok: false, code: 'wo_ambiguous',
      reply: { kind: 'clarify', composed: workorderChoices(side.cap, input.intent, numbered, found.more, typed) },
    };
  }
  const row = await scopedFindById(side.cap, side.ctx, numbered[0].id);
  return row ? { row } : refusal('wo_not_found', woNotFound(typed));
}

/** The lifecycle's choice of target (composeTargetChoices), each option starting the invoice from that work order. */
function workorderChoices(cap: ModuleCap, intent: WriteIntent, matches: EntityMatch[], more: boolean, text: string): ComposedAnswer {
  const composed = composeTargetChoices({ cap, intent, matches, more, reason: 'duplicate_number', text });
  return {
    ...composed,
    blocks: composed.blocks.map((block) => (block.type !== 'clarify' ? block : {
      ...block,
      options: block.options.map((option) => {
        const { run } = option;
        if (!('intent' in run)) return option;
        const { target, ...rest } = run.intent;
        return target && 'ref' in target ? { ...option, run: { intent: { ...rest, from: { module: 'workorder', ref: target.ref } } } } : option;
      }),
    })),
  };
}

/** The work order as the screen's Create Invoice sees it (C13): the API's JSON of the hydrated document, where
 * each line has its schema defaults (amount 0, count 1, tax and discount 0), so the prefill's fallbacks pick the
 * same values the screen picks. Only what an invoice copies is hydrated. */
function screenCopyOf(row: Record<string, unknown>): Record<string, unknown> {
  const pick = {
    _id: row._id, customerId: row.customerId, workOrderId: row.workOrderId, address: row.address, notes: row.notes,
    services: row.services, parts: row.parts, discount: row.discount, gstPercentage: row.gstPercentage,
    quotationId: row.quotationId, contractId: row.contractId,
  };
  return JSON.parse(JSON.stringify(NativeWorkorder.hydrate(pick))) as Record<string, unknown>;
}

/** A line copied exactly as stored that the screen's Zod and the invoice model take as it is: a name, an amount
 * of 0 or more, a whole count from 1 to 100,000 when set, tax and discount from 0 to 100 when set. */
function copyable(line: unknown): boolean {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return false;
  const { name, amount, count, taxPercent, discountPercent } = line as Record<string, unknown>;
  const within = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  return typeof name === 'string' && name.trim() !== ''
    && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    && (count === undefined || (Number.isInteger(count) && within(count, 1, LINE_CAPS.qty)))
    && (taxPercent === undefined || within(taxPercent, 0, 100))
    && (discountPercent === undefined || within(discountPercent, 0, 100));
}

/** A prefill number as the screen sends it (the hydrated document's numbers are numbers). */
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/** The work order's customer as the caller may see it, read by its business id under the customer module's gates
 * and scope; null when hidden (the invoice still takes the work order's customer, shown by its number). */
async function customerRefOf(key: string, gate: RelatedGate): Promise<StoredRef | null> {
  if (!key) return null;
  const side = await gate('customer');
  if (!side.ok) return null;
  try {
    const [match] = await recentEntities(side.cap, side.ctx, { keyPath: 'customerId', limit: 1, extra: [{ customerId: key }] });
    if (!match || match.key !== key) return null;
    return { module: 'customer', id: match.id, key, label: match.label, ...(match.number ? { number: match.number } : {}) };
  } catch (err) {
    if (err instanceof ScopeFailClosedError) return null;
    throw err;
  }
}

/** Whether the work order the request names can be invoiced from the chat, checked in this order (spec B6.3, lead
 * notes C13, C14), each refusal before any draft: a work order (1), its module's gates (2), the record under them
 * (3), a number no other work order holds (3b), completed (4), not already invoiced (5), a customer (6), at most
 * 50 lines the chat can copy (7); then what the invoice takes from it (9). Read-only. */
export async function checkInvoiceEligibility(input: EligibilityInput): Promise<Eligibility> {
  const { from, identity, gate } = input;
  const tenantId = identity.tenantId;
  if ('module' in from && from.module !== 'workorder') return refusal('wrong_module', WO_FROM_WRONG_MODULE);
  const side = await gate('workorder');
  if (!side.ok) return refusal('wo_module', WO_GATE_REFUSED);
  const found = await readWorkorder(input, side);
  if (!('row' in found)) return found;
  const { row } = found;
  // A work order with no number (never saved through the screens' create) can't be linked or checked by createInvoice.
  const number = textOf(row.workOrderId);
  if (!number) return refusal('wo_not_found', WO_NOT_FOUND_GENERIC);

  // 3b. createInvoice reads the work order by its number tenant-wide and takes the first one, whoever can see it.
  const holders = await NativeWorkorder.countDocuments({ tenantId: new mongoose.Types.ObjectId(tenantId), workOrderId: number });
  if (holders > 1) return refusal('wo_number_shared', woNumberShared(number));

  // 4 to 6 read the work order as stored.
  const stages = await peekStages(tenantId, 'workorder');
  const status = textOf(row.status);
  if (status !== completedKeyIn(stages)) return refusal('not_completed', woNotCompleted(number, stageLabel(stages, status)));
  const existing = await existingInvoiceFor(tenantId, number, gate);
  if (existing.count > 0) {
    const { visible } = existing;
    return visible
      ? refusal('already_invoiced', woInvoicedVisible(number, visible.number, visible.statusLabel), recordLinkFor('invoice', visible.id))
      : refusal('already_invoiced', WO_INVOICED_HIDDEN);
  }
  if (!textOf(row.customerId).trim()) return refusal('no_customer', WO_NO_CUSTOMER);

  // 7 and 9 take the work order as the screen's convert sends it.
  const prefill = workorderToInvoicePrefill(screenCopyOf(row));
  const services = listOf(prefill.services);
  const parts = listOf(prefill.parts);
  if (services.length + parts.length > LINE_CAPS.rows) return refusal('too_many_lines', woTooManyLines(number));
  if (![...services, ...parts].every(copyable)) return refusal('lines_uncopyable', woLinesUncopyable(number));

  const customerKey = textOf(prefill.customerId);
  const address = textOf(prefill.address);
  const wo: WoSnapshot = {
    id: hexOf(row._id), number, title: textOf(row.title).trim(), status, statusLabel: stageLabel(stages, status),
    customerKey, customer: await customerRefOf(customerKey, gate),
    // A masked-looking address is never copied (D29): the person types the billing address.
    address: looksMasked(address) ? '' : address,
    services, parts,
    discount: numberOf(prefill.discount), gstPercentage: numberOf(prefill.gstPercentage), notes: textOf(prefill.notes),
    ...(typeof prefill.quotationId === 'string' ? { quotationId: prefill.quotationId } : {}),
    ...(typeof prefill.contractId === 'string' ? { contractId: prefill.contractId } : {}),
  };
  return { ok: true, wo, digest: woDigest(wo) };
}

/** A value with the keys of every object sorted (undefined left out), so key order never changes its JSON. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sortedKeys(record[key])]));
}

/** sha256 (hex) of what an invoice copies from the work order, key order aside: review and Confirm compare it with
 * the work order as it is then. */
export function woDigest(wo: WoSnapshot): string {
  const copied = {
    customerKey: wo.customerKey, status: wo.status, address: wo.address, services: wo.services, parts: wo.parts,
    discount: wo.discount, gstPercentage: wo.gstPercentage, quotationId: wo.quotationId, contractId: wo.contractId,
  };
  return createHash('sha256').update(JSON.stringify(sortedKeys(copied))).digest('hex');
}

/** createInvoice's eligibility templates (invoice.service.ts assertWorkOrderEligibleForInvoice): each starts with
 * the work order's number in quotes, then a fixed phrase. */
const CREATE_INVOICE_TEMPLATE = /^Work Order "[^"]*" (was not found|belongs to customer|has not been completed yet|is already invoiced on invoice)/;
const TEMPLATE_CODES = {
  'was not found': 'wo_not_found',
  'belongs to customer': 'other_customer',
  'has not been completed yet': 'not_completed',
  'is already invoiced on invoice': 'already_invoiced',
} as const;

/** What createInvoice refused, from its own message; null for any other message. The messages name another
 * invoice and another customer, read without scope, so only the code goes on, never the text. */
export function mapCreateInvoiceError(message: string): 'already_invoiced' | 'not_completed' | 'other_customer' | 'wo_not_found' | null {
  const match = typeof message === 'string' ? CREATE_INVOICE_TEMPLATE.exec(message) : null;
  return match ? TEMPLATE_CODES[match[1] as keyof typeof TEMPLATE_CODES] : null;
}
