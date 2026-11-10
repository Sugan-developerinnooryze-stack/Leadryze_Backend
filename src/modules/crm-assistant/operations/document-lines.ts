import type { WriteIntent } from '../contracts/plan';
import { LINE_CAPS } from '../contracts/views';
import type { EntityChoice, LineEdit, LineRow, LookupResult, SectionState, Totals } from '../contracts/views';
import type { RelatedGate, RelatedRefusal } from '../query/relations';
import { MAX_ENTITY_MATCHES, recentEntities, resolveEntity } from '../query/resolve-entity';
import type { EntityMatch } from '../query/resolve-entity';
import { ScopeFailClosedError, isObjectIdText, scopedFindById } from '../query/scoped-match';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteLineSpec } from '../registry/types';
import type { SealedLine } from '../writes/workflow-types';
import { screenCents } from '../../native-crm/shared/document-totals';
import type { DocumentTotals } from '../../native-crm/shared/document-totals';

/* A document's lines (Increment 7, spec B5.1 to B5.3): the rows a draft
 * holds beside its form (WorkflowSealed.lines), the write values they become
 * (`services` and `parts`, before the screen's Zod), the rows and totals the
 * blocks show, and the catalog reads that price them. Every catalog read goes
 * through the service or part module's own gate and scope, active records
 * only; a price never comes from the browser, the grammar or the planner.
 *
 * A row is a catalog pick (`catalog`: the record's _id, name, number and price
 * as last read on the server) or a line carried verbatim from the record a
 * create is made from (`line`). Keys: s<i> and p<i> carried from a source,
 * c<i> priced from the request's words, the browser's n<i>; never repeated in
 * a form. Nothing here writes, and nothing logs a name, a price or the text
 * searched. */

/** The write keys the lines fill (never a form field). */
export const LINE_WRITE_KEYS: ReadonlySet<string> = new Set(['services', 'parts']);
/** The largest quantity a chat line may take (a whole number from 1). */
export const LINE_QTY_MAX = 9999;

/* Texts (spec B12, exact). */
const LINES_REQUIRED = 'Add at least one service.';
const LINE_QTY = `Use a whole number from 1 to ${LINE_QTY_MAX}.`;
const LINE_NOT_IN_CATALOG = 'This service is no longer in your catalog.';
const LINES_HIDDEN = "You can't look up services here.";
const linesTooMany = (max: number) => `Use at most ${max} lines here.`;
const lineGone = (name: string) => `${name} is no longer in your catalog, or you can no longer see it.`;
const linePriceChanged = (name: string, money: string) => `The price of ${name} changed to ${money}.`;
const lineWordsNotTaken = (words: string) => `Add "${words}" with Add a service.`;
const invalidLines = (why: string) => ({ ok: false as const, message: `Invalid lines: ${why}` });

/** Only catalog records not marked inactive are offered or priced (M9). */
const ACTIVE: Record<string, unknown> = { status: { $ne: 'inactive' } };
/** On focus, with nothing typed: the newest catalog records the caller can see. */
const RECENT_LIMIT = 5;
/** The longest text searched (LookupRequestSchema caps q at 100). */
const MAX_QUERY = 100;
/** A row with no name of its own. */
const NO_NAME = 'Line';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Words as the name search and the person read them: one space between words, trimmed. */
function wordsOf(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A chat quantity: a whole number from 1 to LINE_QTY_MAX. */
function isLineQty(qty: unknown): qty is number {
  return typeof qty === 'number' && Number.isInteger(qty) && qty >= 1 && qty <= LINE_QTY_MAX;
}

/** Money in a sentence (spec A7): "INR 2196.57". */
function moneyText(amount: number, currency: string | null): string {
  return `${currency ?? 'INR'} ${amount.toFixed(2)}`;
}

/** finite(v) of spec B5.3: Number(v ?? 0) when finite, else 0. */
function finite(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/* ── Rows and their write values (B5.1) ────────────────────────────────── */

/** The write values of the rows, in row order: a catalog pick as the drawer stores one (`{ name, amount, count }`,
 * a part also its part number, M9), a carried line verbatim (the screen's Zod then keeps exactly what the screen
 * sends). Both arrays are always there, as the screen's convert sends them. */
export function linesToWrite(lines: readonly SealedLine[]): { services: Array<Record<string, unknown>>; parts: Array<Record<string, unknown>> } {
  const services: Array<Record<string, unknown>> = [];
  const parts: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let out: Record<string, unknown>;
    if (line.origin === 'source') {
      out = { ...(line.line ?? {}) };
    } else {
      // A catalog row without its record is never sealed by the server; written without a name, Zod refuses it.
      const catalog = line.catalog;
      out = { name: catalog?.name ?? '', amount: catalog?.price, count: line.qty };
      if (line.kind === 'part' && catalog?.partNumber) out.partNumber = catalog.partNumber;
    }
    (line.kind === 'part' ? parts : services).push(out);
  }
  return { services, parts };
}

/* ── Rows and totals for the blocks (B5.3) ─────────────────────────────── */

/** One row as the form and the review show it: name, quantity, unit price and amount (qty x unit, to the cent) in
 * the branch's currency, the catalog record or the record it came from, and a carried service line's own rates. */
function rowOf(line: SealedLine, currency: string | null, fromNumber: string | undefined): LineRow {
  const shownCurrency = currency ? clip(currency, 8) : null;
  const money = (v: number | null) => ({ t: 'money' as const, v, currency: shownCurrency });
  const amountOf = (unit: number | null, qty: number) => (unit === null ? null : Math.round(unit * qty * 100) / 100);
  if (line.origin !== 'source') {
    const catalog = line.catalog;
    const name = clip(catalog?.name || NO_NAME, 200);
    const unit = catalog && Number.isFinite(catalog.price) ? catalog.price : null;
    return {
      key: line.key, kind: line.kind,
      ...(catalog ? {
        catalogRef: {
          module: line.kind, id: clip(catalog.id, 64), ...(catalog.number ? { number: clip(catalog.number, 80) } : {}), label: name,
          source: getModuleCap(line.kind)?.group ?? 'field_service',
        },
      } : {}),
      name,
      ...(line.kind === 'part' && catalog?.partNumber ? { detail: clip(`Part no. ${catalog.partNumber}`, 200) } : {}),
      qty: line.qty, unitPrice: money(unit), amount: money(amountOf(unit, line.qty)), priceFrom: 'catalog',
    };
  }
  const src = line.line ?? {};
  const qty = Number(src.count ?? 1);
  const amount = Number(src.amount);
  const unit = Number.isFinite(amount) ? amount : null;
  const partNumber = line.kind === 'part' ? textOf(src.partNumber) : undefined;
  const detail = partNumber ? `Part no. ${partNumber}` : textOf(src.description);
  const rate = (value: unknown) => {
    const n = Number(value);
    return line.kind === 'service' && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const taxPercent = rate(src.taxPercent);
  const discountPercent = rate(src.discountPercent);
  return {
    key: line.key, kind: line.kind,
    name: clip(textOf(src.name) ?? NO_NAME, 200),
    ...(detail ? { detail: clip(detail, 200) } : {}),
    qty, unitPrice: money(unit), amount: money(amountOf(unit, qty)), priceFrom: 'source_document',
    ...(fromNumber ? { from: clip(fromNumber, 80) } : {}),
    ...(taxPercent !== undefined ? { taxPercent } : {}),
    ...(discountPercent !== undefined ? { discountPercent } : {}),
  };
}

/** The rows of a form or a review (at most the contract's 50). */
export function lineRowsOf(lines: readonly SealedLine[], currency: string | null, fromNumber?: string): LineRow[] {
  return lines.slice(0, LINE_CAPS.rows).map((line) => rowOf(line, currency, fromNumber));
}

/** The totals the blocks show, from the service's own totals (computeDocumentTotals on the payload after the
 * screen's Zod), each as the list and view pages print it (screenCents). `stored`: what the record will store,
 * the back-fill when the totals give one, else the payload's value. null when the totals can't be shown (a
 * line without a price makes them NaN). */
export function totalsViewOf(t: DocumentTotals, stored: { discount: unknown; gstPercentage: unknown }, currency: string | null): Totals | null {
  if (![t.linesGross, t.servicesAmount, t.servicesAmountWithTax, t.partsAmount].every((n) => Number.isFinite(n))) return null;
  const discountPercent = finite(stored.discount);
  // Header mode: the discount and the tax as InvoiceViewPage and QuotationViewPage print them (their own
  // expressions), so Subtotal - Discount + GST can miss Total by a cent there too. Line mode: the lines' together.
  const off = (t.linesGross * discountPercent) / 100;
  return {
    // LR-R26-CTR-007: mixed totals (a header rate and lines with their own)
    // read like line mode: the lines' discount and tax together.
    mode: t.mode === 'header' ? 'header' : 'line', currency: clip(currency ?? 'INR', 8), subtotal: screenCents(t.linesGross), net: screenCents(t.servicesAmount),
    total: screenCents(t.servicesAmountWithTax), discountPercent, gstPercent: finite(stored.gstPercentage),
    rounded: t.rounded,
    ...(t.partsAmount > 0 ? { servicesSubtotal: screenCents(t.linesGross - t.partsAmount), partsSubtotal: screenCents(t.partsAmount) } : {}),
    discountAmount: t.mode === 'header' ? screenCents(off) : screenCents(t.linesGross - t.servicesAmount),
    taxAmount: t.mode === 'header' ? screenCents(t.servicesAmountWithTax - (t.linesGross - off)) : screenCents(t.servicesAmountWithTax - t.servicesAmount),
  };
}

/** The list's own errors ('lines': too many rows, or none while the create needs one) and each catalog row's
 * quantity ('lines.<key>'). A create made from another record needs no line (M11: a warning only). */
export function checkLines(lines: readonly SealedLine[], spec: WriteLineSpec, fromSource: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (lines.length > spec.max) errors.lines = linesTooMany(spec.max);
  else if (!lines.length && spec.required && !fromSource) errors.lines = LINES_REQUIRED;
  for (const line of lines) {
    if (line.origin !== 'source' && !isLineQty(line.qty)) errors[`lines.${line.key}`] = LINE_QTY;
  }
  return errors;
}

/* ── Catalog reads, typed lines and edits (B5.2) ───────────────────────── */

/** One catalog record priced as the drawer's pick prices it, read under the service or part module's own gates
 * and scope (scopedFindById: never an unscoped read): refused (the gate, or a scope that can't be built), gone
 * (not visible, no usable price or no name) or inactive; else its _id, name, number, price and a part's number. */
export async function priceCatalogLine(kind: 'service' | 'part', ref: string, gate: RelatedGate):
  Promise<{ ok: true; catalog: NonNullable<SealedLine['catalog']> } | { ok: false; reason: 'gone' | 'inactive' | 'refused' }> {
  const side = await gate(kind);
  if (!side.ok) return { ok: false, reason: 'refused' };
  let row: Record<string, unknown> | null;
  try {
    row = await scopedFindById(side.cap, side.ctx, ref);
  } catch (err) {
    if (err instanceof ScopeFailClosedError) return { ok: false, reason: 'refused' };
    throw err;
  }
  if (!row) return { ok: false, reason: 'gone' };
  if (row.status === 'inactive') return { ok: false, reason: 'inactive' };
  const price = Number(row.price);
  const name = textOf(row.name);
  if (!Number.isFinite(price) || price < 0 || !name) return { ok: false, reason: 'gone' };
  const stored = String(row._id ?? '');
  const number = side.cap.ids.business ? textOf(row[side.cap.ids.business]) : undefined;
  const partNumber = kind === 'part' ? textOf(row.partNumber) : undefined;
  return {
    ok: true,
    catalog: {
      id: (isObjectIdText(stored) ? stored : ref).toLowerCase(), name, ...(number ? { number } : {}), price,
      ...(partNumber ? { partNumber } : {}),
    },
  };
}

/** The catalog lines a request named in words (M13): each, in order, becomes a priced row (c1, c2, ...) only when
 * exactly one active record the caller can see is named by the whole text (case and spaces aside); anything else
 * (a kind these lines don't take, a quantity that isn't a whole number from 1 to 9999, a refused module, several
 * or partial matches, the deadline passed, or the form full) goes to "Not taken", with one warning naming the
 * first words not taken. */
export async function resolveIntentLines(lines: NonNullable<WriteIntent['lines']>, spec: WriteLineSpec, gate: RelatedGate, deadline: number):
  Promise<{ lines: SealedLine[]; notTaken: string[]; warnings: string[] }> {
  const out: SealedLine[] = [];
  const notTaken: string[] = [];
  const norm = (s: string) => wordsOf(s).toLowerCase();
  for (const typed of lines) {
    const text = wordsOf(typed.text);
    if (!text) continue;
    const qty = typed.qty ?? 1;
    if (out.length >= spec.max || !spec.add.includes(typed.catalog) || !isLineQty(qty) || Date.now() >= deadline) {
      notTaken.push(text);
      continue;
    }
    const side = await gate(typed.catalog);
    let match: EntityMatch | undefined;
    if (side.ok) {
      try {
        const found = await resolveEntity(side.cap, { text }, side.ctx, { keyPath: '_id', limit: MAX_ENTITY_MATCHES, extra: [ACTIVE] });
        match = found.matches.length === 1 && !found.more && norm(found.matches[0].label) === norm(text) ? found.matches[0] : undefined;
      } catch (err) {
        if (!(err instanceof ScopeFailClosedError)) throw err;
      }
    }
    const priced = match ? await priceCatalogLine(typed.catalog, match.id, gate) : null;
    if (!priced?.ok) {
      notTaken.push(text);
      continue;
    }
    out.push({ key: `c${out.length + 1}`, kind: typed.catalog, origin: 'catalog', qty, catalog: priced.catalog });
  }
  return { lines: out, notTaken, warnings: notTaken.length ? [lineWordsNotTaken(notTaken[0])] : [] };
}

/** The browser's whole line list (a validate body's `lines`): a row is kept by its key (taking the quantity sent),
 * removed by leaving it out, and added with the catalog record picked, priced here. The list is refused whole (400)
 * when it can't be one of this form's: a key twice, more than the form's rows, a kept row given another kind or
 * record, a new key without a record, or a kind these lines don't take. A quantity above 9999 keeps the row's
 * last one (a new row starts at 1) with LINE_QTY on the row; a pick that is gone, inactive or out of sight isn't
 * added, with the list's error. The result keeps the edits' order. */
export async function applyLineEdits(current: readonly SealedLine[], edits: readonly LineEdit[], spec: WriteLineSpec, gate: RelatedGate):
  Promise<{ ok: true; lines: SealedLine[]; errors: Record<string, string> } | { ok: false; message: string }> {
  const rows = new Map(current.map((line) => [line.key, line]));
  if (new Set(edits.map((edit) => edit.key)).size !== edits.length) return invalidLines('a key is used twice.');
  if (edits.length > spec.max) return invalidLines(`more than ${spec.max} rows.`);
  for (const edit of edits) {
    const row = rows.get(edit.key);
    if (row) {
      // The row's own record sent again (an add sent twice) is that row; a carried line has no record to send.
      const own = row.catalog?.id;
      if (row.kind !== edit.kind || (edit.ref !== undefined && (!own || own.toLowerCase() !== edit.ref.toLowerCase()))) {
        return invalidLines(`${edit.key} can't change its record.`);
      }
    } else if (edit.ref === undefined) {
      return invalidLines(`${edit.key} is not a line of this form.`);
    } else if (!spec.add.includes(edit.kind)) {
      return invalidLines(`${edit.kind} lines can't be added here.`);
    }
  }

  const lines: SealedLine[] = [];
  const errors: Record<string, string> = {};
  for (const edit of edits) {
    const row = rows.get(edit.key);
    const qtyOk = isLineQty(edit.qty);
    if (!qtyOk) errors[`lines.${edit.key}`] = LINE_QTY;
    if (row) {
      lines.push({ ...row, qty: qtyOk ? edit.qty : row.qty });
      continue;
    }
    const priced = await priceCatalogLine(edit.kind, edit.ref!, gate);
    if (!priced.ok) {
      delete errors[`lines.${edit.key}`];
      errors.lines ??= priced.reason === 'refused' ? LINES_HIDDEN : LINE_NOT_IN_CATALOG;
      continue;
    }
    lines.push({ key: edit.key, kind: edit.kind, origin: 'catalog', qty: qtyOk ? edit.qty : 1, catalog: priced.catalog });
  }
  return { ok: true, lines, errors };
}

/** Review and Confirm (M12): every catalog row priced again under the caller's gates now. One gone, inactive or out
 * of sight stays as it was with LINE_GONE on it; a new price refreshes the row with LINE_PRICE_CHANGED (Confirm then
 * finds the reviewed values changed); a new name or number refreshes it silently. Carried rows are left alone. */
export async function recheckCatalogLines(lines: readonly SealedLine[], gate: RelatedGate, currency: string | null):
  Promise<{ lines: SealedLine[]; errors: Record<string, string>; warnings: string[] }> {
  const out: SealedLine[] = [];
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  for (const line of lines) {
    if (line.origin === 'source') {
      out.push(line);
      continue;
    }
    const was = line.catalog;
    const priced = was ? await priceCatalogLine(line.kind, was.id, gate) : null;
    if (!priced?.ok) {
      out.push(line);
      errors[`lines.${line.key}`] = lineGone(was?.name || NO_NAME);
      continue;
    }
    if (priced.catalog.price !== was!.price) warnings.push(linePriceChanged(priced.catalog.name, moneyText(priced.catalog.price, currency)));
    out.push({ ...line, catalog: priced.catalog });
  }
  return { lines: out, errors, warnings };
}

function catalogChoiceOf(cap: ModuleCap, match: EntityMatch): EntityChoice {
  return {
    module: cap.key, id: match.id, label: match.label, source: cap.group,
    ...(match.number ? { number: match.number } : {}), ...(match.detail ? { detail: match.detail } : {}),
  };
}

/** A refused catalog module: its state, "You can't look up <plural> here." (B20 REF_HIDDEN), no records. */
function refusedLookup(module: string, reason: RelatedRefusal): { http: 200; result: LookupResult } {
  const plural = (getModuleCap(module)?.labels.plural ?? 'records').toLowerCase();
  const status: SectionState['status'] = reason === 'no_permission' ? 'no_permission' : reason === 'unknown_module' ? 'unsupported' : 'disabled';
  return { http: 200, result: { items: [], more: false, state: { status, message: `You can't look up ${plural} here.` } } };
}

/** The Add picker's search (the lookup's field 'lines'): the active catalog records of a kind these lines take
 * (the only one when none is named), under that module's own gates and scope; the newest five with nothing typed,
 * else at most ten by name with `more`. The text searched is never logged. */
export async function lookupCatalogLines(input: { spec: WriteLineSpec; module?: string; q: string; gate: RelatedGate }):
  Promise<{ http: 200; result: LookupResult } | { http: 400; message: string }> {
  const { spec } = input;
  const module = input.module ?? (spec.add.length === 1 ? spec.add[0] : undefined);
  const kind = spec.add.find((k) => k === module);
  if (!kind) return { http: 400, message: 'Invalid lookup request: module is not one these lines take' };
  const side = await input.gate(kind);
  if (!side.ok) return refusedLookup(kind, side.reason);
  const q = wordsOf(input.q).slice(0, MAX_QUERY);
  try {
    const found = q
      ? await resolveEntity(side.cap, { text: q }, side.ctx, { keyPath: '_id', limit: MAX_ENTITY_MATCHES, extra: [ACTIVE] })
      : { matches: await recentEntities(side.cap, side.ctx, { keyPath: '_id', limit: RECENT_LIMIT, extra: [ACTIVE] }), more: false };
    const items = found.matches.slice(0, MAX_ENTITY_MATCHES).map((m) => catalogChoiceOf(side.cap, m));
    return {
      http: 200,
      result: { items, more: found.more || found.matches.length > MAX_ENTITY_MATCHES, state: { status: items.length ? 'ok' : 'empty' } },
    };
  } catch (err) {
    // The scope couldn't be built for the catalog: nothing is read, as for a refused module.
    if (err instanceof ScopeFailClosedError) return refusedLookup(kind, 'no_permission');
    throw err;
  }
}
