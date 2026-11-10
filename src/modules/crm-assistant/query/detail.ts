import type { ModuleCap } from '../registry/types';
import type { QueryPlan } from '../contracts/plan';
import type { DataScope } from '../../../types';
import { getModuleCap } from '../registry';
import { relationsFrom } from '../registry/relations';
import type { RelationDef } from '../registry/relations';
import { queryCapsFor } from '../registry/query-caps';
import { applyPIIProtection, isForbiddenReadKey, projectForDetail } from '../../internal/crm-read.service';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import type { ExecContext, ReadContext } from './execute-list';
import { MAX_NUMBER_MATCHES, loadReadContext, moduleDefFor, recordCurrenciesRead, withRecordCurrencies } from './execute-list';
import { executeQueryCount } from './execute-query';
import type { RelatedGate } from './relations';
import { childConditionFor, relationParentOf } from './relations';
import { isObjectIdText, recordIdsByNumber, scopedCount, scopedFindById } from './scoped-match';
import { logger } from '../../../utils/logger';

/* The record card's data (Increment 5, decision LD4): one record, read under
 * the caller's scope, and what its card shows besides its fields.
 *
 *   by number  as executor L always has (execute-list.ts
 *              executeDetailByNumber): the records carrying the number, each
 *              read through the module's own getById under the scope, so only
 *              the ones the caller may see are counted (two can share a
 *              number: duplicates).
 *   by ref     a server-written _id (a duplicate number's choice, a related
 *              record): executor Q modules through scopedFindById, the same
 *              closed scope and branch as their lists (a contact gets its
 *              contactOwner scope this way, so a contact shown in a list
 *              opens); a module executor Q never runs (supervisors) through
 *              its getById.
 *
 * The fields shown are the projected record, exactly as GET /crm-get projects
 * it (applyPIIProtection, the read allowlist, READ_FORBIDDEN_KEYS). Besides:
 *   lines    the services and parts of an invoice, quotation or contract,
 *            from the same read of the one record through this file's own
 *            allowlist (item name, quantity, unit amount; the line total is
 *            the quantity times the amount, as the screens show it), at most
 *            MAX_DETAIL_LINES. Nothing else of the stored record is read for
 *            them (the invoice's read allowlist stays as it is: decision WB1).
 *   totals   the stored totals (invoice: after discount, total, paid, balance
 *            due; quotation and contract: after discount, total), never
 *            recomputed; before them the screens' Subtotal (the lines before
 *            the discount), when every line was read and a discount makes it
 *            differ. Money is in the record's own branch currency (D2).
 *   related  for every relation whose parent is this module
 *            (registry/relations.ts), how many of the child's records refer to
 *            this one, counted under the child module's own gates and scope:
 *            a module the caller can't use is that state, never a count; a
 *            scope narrower than everything is partial ("visible to you"); a
 *            count that fails or takes too long is an error, never a zero.
 *            Each carries the plan of the list behind it (the child's records
 *            for this record, entity { ref }). When other records the caller
 *            can see carry the same number, the rows counted by that number
 *            say so (shared): those children can't be told apart. */

export type DetailRead =
  /** `ctx`: the caller's context the record was read under (its related rows ask it whether another record shares its
   * number). `uniqueNumber`: the read already knows none does (by number, every record carrying it was checked). */
  | { kind: 'record'; record: Record<string, unknown>; raw: Record<string, unknown>; read: ReadContext; ctx: ExecContext; uniqueNumber?: true }
  | { kind: 'duplicates'; matches: Record<string, unknown>[]; read: ReadContext }
  | { kind: 'not_found' };

/** At most this many lines are shown (the record card's own cap). */
export const MAX_DETAIL_LINES = 50;

/** The records whose lines a card shows, and their line-item paths. */
const LINE_ITEMS: Readonly<Record<string, ReadonlyArray<{ path: string; kind: 'service' | 'part' }>>> = {
  invoice: [{ path: 'services', kind: 'service' }, { path: 'parts', kind: 'part' }],
  quotation: [{ path: 'services', kind: 'service' }, { path: 'parts', kind: 'part' }],
  contract: [{ path: 'services', kind: 'service' }, { path: 'parts', kind: 'part' }],
};

/** The services and parts after the discount, before tax: what
 * quotation.service.ts, invoice.service.ts and contract.service.ts store in
 * servicesAmount. The screens' "Subtotal" is the lines before the discount. */
const AFTER_DISCOUNT = 'servicesAmount';
/** The key of the screens' Subtotal on a card (no stored field has it). */
const LINES_SUBTOTAL = 'linesSubtotal';

/** The stored totals a card shows, by module (each in its read allowlist). */
const STORED_TOTALS: Readonly<Record<string, ReadonlyArray<{ key: string; label: string }>>> = {
  invoice: [
    { key: AFTER_DISCOUNT, label: 'After discount' }, { key: 'servicesAmountWithTax', label: 'Total' },
    { key: 'paidAmount', label: 'Paid' }, { key: 'balanceDue', label: 'Balance due' },
  ],
  quotation: [{ key: AFTER_DISCOUNT, label: 'After discount' }, { key: 'servicesAmountWithTax', label: 'Total' }],
  contract: [{ key: AFTER_DISCOUNT, label: 'After discount' }, { key: 'servicesAmountWithTax', label: 'Total' }],
};

export interface DetailLine {
  kind: 'service' | 'part';
  name: string | null;
  qty: number | null;
  /** The unit amount, as stored. */
  amount: number | null;
  /** qty x amount, as the screens show it; null when the amount isn't stored. */
  total: number | null;
}

export interface DetailTotal { key: string; label: string; value: number }

export type RelatedStatus = 'ok' | 'partial' | 'no_permission' | 'disabled' | 'error';

export interface RelatedCount {
  def: RelationDef;
  /** The child module (its registry entry, also when the caller can't use it). */
  child: ModuleCap;
  /** null when it wasn't counted (no access, switched off, failed): never 0. */
  count: number | null;
  status: RelatedStatus;
  /** The caller's scope for the child, when it was gated. */
  scopeKind?: DataScope['kind'];
  /** The count didn't finish within its budget. */
  timedOut?: boolean;
  /** The child's records for this record (relation for, entity { ref }); absent when the caller can't use the child. */
  drill?: QueryPlan;
  /** Several records the caller can see carry this record's number (numbers
   * can repeat) and the child refers to the number only: the count, and its
   * list, are of all of their children together, never this record's alone. */
  shared?: { records: number; number: string };
}

export interface DetailExtrasData {
  lines?: { rows: DetailLine[]; total: number };
  totals?: DetailTotal[];
  related?: RelatedCount[];
}

/* ── Reading the record ────────────────────────────────────────────────── */

function plainOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const doc = value as { toObject?: () => unknown };
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : value;
  return plain && typeof plain === 'object' ? plain as Record<string, unknown> : null;
}

function idOf(record: Record<string, unknown>): string {
  return String(record._id ?? '');
}

function stripForbidden(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) if (key === '_id' || !isForbiddenReadKey(key)) out[key] = value;
  return out;
}

/** GET /crm-get's post-processing (as executeDetailByNumber's): PII protection,
 * the read allowlist without the writable-field union (that lookup reads the
 * field catalog, which can create pipeline stages), READ_FORBIDDEN_KEYS. */
async function projected(cap: ModuleCap, rows: Record<string, unknown>[], ctx: ExecContext): Promise<Record<string, unknown>[]> {
  const def = moduleDefFor(cap);
  const piiSafe = await applyPIIProtection(rows, def.logModule, ctx.tenantId, ctx.branchId, ctx.identity.role ?? 'AGENT');
  return piiSafe.map((item) => stripForbidden(projectForDetail(item, def, [])));
}

/** The record's branch as lower-case hex; null when it has none. */
function branchOf(raw: Record<string, unknown>): string | null {
  const value = raw.branchId;
  const hex = value && typeof value === 'object' ? String(value) : typeof value === 'string' ? value : '';
  return isObjectIdText(hex) ? hex.toLowerCase() : null;
}

/** The read context of one record's card. Decision D2: a document's money is
 * in its own branch's currency, as the named totals read it (scoped-match.ts
 * branchCurrencyExpression), while loadReadContext gives the caller's branch
 * currency. So a record of another branch (an admin with no branch picked
 * opening a Dubai invoice) takes its branch's: that branch's FS settings
 * currency, else the org's (getSettings falls back so). A failed read leaves
 * the currency unknown, never the caller's. */
async function recordReadContext(cap: ModuleCap, raw: Record<string, unknown>, ctx: ExecContext): Promise<ReadContext> {
  const branch = branchOf(raw);
  const ownCurrency = branch !== null && branch !== (ctx.branchId ?? '').toLowerCase()
    && cap.fields.some((f) => f.money?.currency === 'fs_branch');
  const [read, settings] = await Promise.all([
    loadReadContext(cap, moduleDefFor(cap), ctx),
    ownCurrency ? getSettings(ctx.tenantId, branch).catch(() => null) : Promise.resolve(null),
  ]);
  if (!ownCurrency) return read;
  return { ...read, currency: typeof settings?.currency === 'string' ? settings.currency : null };
}

/** One record by its server-written _id, under the caller's scope (see the header). */
export async function readRecordByRef(cap: ModuleCap, ref: string, ctx: ExecContext): Promise<DetailRead> {
  if (!isObjectIdText(ref)) return { kind: 'not_found' };
  const def = moduleDefFor(cap);
  let raw: Record<string, unknown> | null;
  if (queryCapsFor(cap.key)?.q) {
    raw = await scopedFindById(cap, ctx, ref);
  } else {
    if (!def.getById) throw new Error(`"${cap.key}" has no record lookup`);
    raw = plainOf(await def.getById(ref, ctx.tenantId, ctx.scope));
  }
  if (!raw) return { kind: 'not_found' };
  const [record, read] = await Promise.all([projected(cap, [raw], ctx), recordReadContext(cap, raw, ctx)]);
  return record.length ? { kind: 'record', record: record[0], raw, read, ctx } : { kind: 'not_found' };
}

/** One record by its business number, as executeDetailByNumber reads it
 * (candidates by number in the caller's tenant and branch, each through
 * getById under the scope), keeping the stored record for its lines and
 * related counts. */
export async function readRecordByNumber(cap: ModuleCap, number: string, ctx: ExecContext): Promise<DetailRead> {
  const def = moduleDefFor(cap);
  const field = cap.ids.business;
  if (!field || !def.getById) throw new Error(`"${cap.key}" has no record-number lookup`);
  const candidates = await recordIdsByNumber(cap, ctx, field, number, MAX_NUMBER_MATCHES + 1);
  const fetched = await Promise.all(candidates.map((c) => def.getById!(String(c._id), ctx.tenantId, ctx.scope)));
  const seen = new Set<string>();
  const visible: Record<string, unknown>[] = [];
  for (const found of fetched) {
    const raw = plainOf(found);
    if (!raw || seen.has(idOf(raw))) continue;
    seen.add(idOf(raw));
    visible.push(raw);
  }
  if (!visible.length) return { kind: 'not_found' };
  // One record: its card, in its own branch's currency; several share the number: a choice each, read as a list is.
  const [records, read] = await Promise.all([
    projected(cap, visible, ctx), visible.length === 1 ? recordReadContext(cap, visible[0], ctx) : loadReadContext(cap, def, ctx),
  ]);
  // A choice's total, where it is what tells two apart, in its own company's currency (D2), as a list shows it.
  if (records.length !== 1) return { kind: 'duplicates', matches: records, read: withRecordCurrencies(read, visible, await recordCurrenciesRead(cap, ctx)) };
  // When every record carrying the number was checked (no more than the lookup's cap), it is the only one the caller can see.
  const checkedAll = candidates.length <= MAX_NUMBER_MATCHES;
  return { kind: 'record', record: records[0], raw: visible[0], read, ctx, ...(checkedAll ? { uniqueNumber: true as const } : {}) };
}

/* ── Lines and totals ──────────────────────────────────────────────────── */

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function nameOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Every service and part line of the record through the allowlist above
 * (null for a module without lines): name, quantity (a missing one reads as
 * 1, as on the screens), unit amount, and their product rounded to cents.
 * `complete`: each line could be read, with its amount. */
function readLines(cap: ModuleCap, raw: Record<string, unknown>): { rows: DetailLine[]; complete: boolean } | null {
  const paths = Object.prototype.hasOwnProperty.call(LINE_ITEMS, cap.key) ? LINE_ITEMS[cap.key] : undefined;
  if (!paths) return null;
  const rows: DetailLine[] = [];
  let complete = true;
  for (const { path, kind } of paths) {
    const list = raw[path];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { complete = false; continue; }
      const line = item as Record<string, unknown>;
      const amount = finite(line.amount);
      const qty = finite(line.count) ?? 1;
      if (amount === null) complete = false;
      rows.push({ kind, name: nameOf(line.name), qty, amount, total: amount === null ? null : Math.round(amount * qty * 100) / 100 });
    }
  }
  return { rows, complete };
}

/** The record's lines as its card shows them: at most MAX_DETAIL_LINES, and how many there are. */
export function lineItemsOf(cap: ModuleCap, raw: Record<string, unknown>): { rows: DetailLine[]; total: number } | null {
  const lines = readLines(cap, raw);
  return lines ? { rows: lines.rows.slice(0, MAX_DETAIL_LINES), total: lines.rows.length } : null;
}

/** The screens' Subtotal: every line's quantity times its amount, before the
 * discount (the invoice, quotation and contract pages add them up so),
 * rounded to cents. null for a module without lines, a record with none, or
 * when a line or its amount can't be read (the sum would come up short). */
export function linesSubtotalOf(cap: ModuleCap, raw: Record<string, unknown>): number | null {
  const lines = readLines(cap, raw);
  if (!lines || !lines.complete || !lines.rows.length) return null;
  const sum = lines.rows.reduce((total, line) => total + (line.amount ?? 0) * (line.qty ?? 1), 0);
  return Math.round(sum * 100) / 100;
}

/** The stored totals of an invoice, quotation or contract that hold a number
 * (from the projected record: only what its read allowlist keeps), the
 * after-discount amount labelled as such. `subtotal` (linesSubtotalOf): the
 * screens' Subtotal. With no discount it is the stored after-discount amount
 * itself, which is then labelled Subtotal; with one, it comes first, so the
 * card reads as the screens' summary does. */
export function storedTotalsOf(cap: ModuleCap, record: Record<string, unknown>, subtotal: number | null = null): DetailTotal[] | null {
  const totals = Object.prototype.hasOwnProperty.call(STORED_TOTALS, cap.key) ? STORED_TOTALS[cap.key] : undefined;
  if (!totals) return null;
  return totals.flatMap(({ key, label }): DetailTotal[] => {
    const value = finite(record[key]);
    if (value === null) return [];
    if (key !== AFTER_DISCOUNT || subtotal === null) return [{ key, label, value }];
    if (Math.abs(subtotal - value) < 0.005) return [{ key, label: 'Subtotal', value }];
    return [{ key: LINES_SUBTOTAL, label: 'Subtotal', value: subtotal }, { key, label, value }];
  });
}

/* ── Related counts ────────────────────────────────────────────────────── */

const LATE = Symbol('late');

/** `work`'s result, or LATE once `ms` have passed (the work goes on; its result is dropped). */
function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), Math.max(0, ms)); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The child's records for one parent: the list a related row drills into. */
export function relatedDrillPlan(def: RelationDef, parentId: string): QueryPlan {
  return { v: 1, op: 'list', target: { module: def.child }, relation: { kind: 'for', name: def.parent, entity: { ref: parentId } } };
}

/** One relation's row: the child's gates, then the count of the list behind it. */
async function relatedCount(def: RelationDef, child: ModuleCap, parent: { id: string; key: string }, gate: RelatedGate): Promise<RelatedCount | null> {
  const drill = relatedDrillPlan(def, parent.id);
  const side = await gate(def.child);
  if (!side.ok) {
    // A module the engine doesn't read, or a tenant switched off just now: no row at all.
    return side.reason === 'no_permission' || side.reason === 'disabled' ? { def, child, count: null, status: side.reason } : null;
  }
  const scopeKind = side.ctx.scope.kind;
  // The count of that list: the child's own scope, then this record's key as its own $and member.
  const counted = await executeQueryCount(side.cap, { v: 1, op: 'count', target: { module: def.child } }, side.ctx, {
    conditions: [childConditionFor(def, parent)], notices: [],
  });
  if (counted.total === null) return { def, child: side.cap, count: null, status: 'error', scopeKind, drill };
  return { def, child: side.cap, count: counted.total, status: scopeKind === 'all' ? 'ok' : 'partial', scopeKind, drill };
}

/** How many records the caller can see (`ctx`: the scope the card was read
 * under) carry this record's number, where its relations' children refer to
 * it by that number and the module's numbers can repeat (two quotations can
 * share ABC123-QUO-0001). null when that doesn't apply, the record has no
 * number, or the count fails. */
async function sameNumberCount(
  cap: ModuleCap, raw: Record<string, unknown>, defs: readonly RelationDef[], ctx: ExecContext,
): Promise<{ path: string; number: string; records: number } | null> {
  const def = cap.ids.businessUnique ? undefined : defs.find((d) => d.format === 'business');
  const parent = def ? relationParentOf(def, raw) : null;
  if (!def || !parent?.key) return null;
  try {
    return { path: def.parentKey, number: parent.key, records: await scopedCount(cap, ctx, [{ [def.parentKey]: parent.key }]) };
  } catch (err) {
    logger.warn('CRM assist: records sharing a number could not be counted', { module: cap.key, error: (err as Error)?.message });
    return null;
  }
}

/** One row per relation whose parent is `cap`, in the registry's order, each
 * counted under the child module's own gates (`gate`, one per request). A row
 * whose gates or count fail, or don't finish within `budgetMs`, is an error
 * row (with its list, which can be asked for again), never a zero. With
 * `ctx` (the caller's context for `cap`), rows counted by a number other
 * records the caller can see also carry are marked `shared`: their children
 * can't be told apart (relations-4). That check runs with the counts, under
 * the same budget; one that doesn't finish marks nothing. */
export async function relatedCountsFor(
  cap: ModuleCap, raw: Record<string, unknown>, gate: RelatedGate, budgetMs: number, ctx?: ExecContext,
): Promise<RelatedCount[]> {
  const until = Date.now() + budgetMs;
  const defs = relationsFrom(cap.key);
  const sharing = ctx ? sameNumberCount(cap, raw, defs, ctx) : Promise.resolve(null);
  const rows = await Promise.all(defs.map(async (def): Promise<RelatedCount | null> => {
    const child = getModuleCap(def.child);
    const parent = relationParentOf(def, raw);
    if (!child || !parent) return null;
    try {
      const row = await withinBudget(relatedCount(def, child, parent, gate), budgetMs);
      return row === LATE ? { def, child, count: null, status: 'error', timedOut: true, drill: relatedDrillPlan(def, parent.id) } : row;
    } catch (err) {
      logger.warn('CRM assist: a related count failed', { parent: def.parent, module: def.child, error: (err as Error)?.message });
      return { def, child, count: null, status: 'error', drill: relatedDrillPlan(def, parent.id) };
    }
  }));
  const counted = rows.filter((row): row is RelatedCount => row !== null);
  const same = await withinBudget(sharing, until - Date.now());
  if (same === LATE || !same || same.records < 2) return counted;
  const shared = { records: same.records, number: same.number };
  // Only rows with children counted by that number: a zero has nothing to tell apart.
  return counted.map((row) => (row.count && row.def.format === 'business' && row.def.parentKey === same.path ? { ...row, shared } : row));
}

/** Lines, stored totals and related counts of one record read by readRecordByRef or readRecordByNumber. */
export async function detailExtrasFor(
  cap: ModuleCap, found: Extract<DetailRead, { kind: 'record' }>, gate: RelatedGate, budgetMs: number,
): Promise<DetailExtrasData> {
  const lines = lineItemsOf(cap, found.raw);
  const totals = storedTotalsOf(cap, found.record, linesSubtotalOf(cap, found.raw));
  // Whether another record the caller can see shares its number is asked only when the read doesn't already know.
  const related = await relatedCountsFor(cap, found.raw, gate, budgetMs, found.uniqueNumber ? undefined : found.ctx);
  return {
    ...(lines && lines.total > 0 ? { lines } : {}),
    ...(totals && totals.length ? { totals } : {}),
    ...(related.length ? { related } : {}),
  };
}
