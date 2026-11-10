import type { Cond, DateExpr, QueryPlan, RelRange } from '../contracts/plan';
import type { FilterChip } from '../contracts/views';
import type { FieldCap, ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import type { StatusInfo } from '../query/execute-list';
import type { PartialReason } from '../query/execute-query';
import { MAX_RELATION_KEYS } from '../query/relations';
import type { RelationOutcome } from '../query/relations';
import { mineLabel } from '../query/mine';
import { scrubIds } from './fallback-text';

/* The filter chips under a table, and the same conditions as plain phrases
 * for the interpretedAs sentence. Built only from the validated plan and
 * server data (stage labels, the caller's currency); a chip id says which
 * part of the plan it stands for, so the browser can ask to drop it:
 *   "mine"   plan.mine                        (removable)
 *   "w<i>"   plan.where[i]                    (removable)
 *   "search" plan.search                      (removable)
 *   "rel"    plan.relation                    (removable, Increment 5)
 *   "cur"    a condition the engine added     (never removable)
 * Labels are plain words ("Assigned to you", "Due: this week", "Amount: more
 * than ₹1,00,000", "Duration: more than 1.5 hours", "Status: Sent", "With
 * invoices visible to you", "For Acme Industries") and never carry a record
 * id. The "mine" chip names whose records they are, never the caller's ids. */

/** A condition the engine adds on its own (query/compile.ts ImpliedCondition). */
export interface ImpliedChip { id: string; cond: Cond }

export interface ChipContext {
  /** Stage labels for the module's status field (ReadContext.status). */
  status: StatusInfo | null;
  /** The currency of 'fs_branch' money fields (ReadContext.currency). */
  branchCurrency: string | null;
  /** Conditions the engine added (the currency next to a deal amount). */
  implied?: readonly ImpliedChip[];
  /** The plan's own conditions, when it pins a currency itself ("deals over $50,000"). */
  where?: readonly Cond[];
}

const MAX_CHIP_LABEL = 120;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const REL_TEXT: Readonly<Record<RelRange, string>> = {
  today: 'today', yesterday: 'yesterday', tomorrow: 'tomorrow',
  this_week: 'this week', last_week: 'last week', next_week: 'next week',
  this_month: 'this month', last_month: 'last month', next_month: 'next month',
  this_quarter: 'this quarter', last_quarter: 'last quarter',
  this_year: 'this year', last_year: 'last year',
  last_7_days: 'last 7 days', next_7_days: 'next 7 days', last_30_days: 'last 30 days', next_30_days: 'next 30 days',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  open: 'Open', closed: 'Closed', overdue: 'Overdue', due_today: 'Due today', expiring: 'Expiring',
};

const STATE_PHRASES: Readonly<Record<string, string>> = {
  open: 'that are open', closed: 'that are closed', overdue: 'that are overdue', due_today: 'due today', expiring: 'expiring',
};

/** The window "expiring" reads without a range of its own (query/compile.ts
 * uses the same): the chip and the sentence always name the window. */
const EXPIRING_WINDOW: RelRange = 'next_30_days';

/** Date labels that already read as a verb ("created this week", "due today"). */
const PARTICIPLE_LABELS: ReadonlySet<string> = new Set([
  'created', 'updated', 'due', 'scheduled', 'starts', 'ends', 'completed', 'resolved', 'closed', 'resolution due', 'first response due',
]);

/* ── Small text helpers ────────────────────────────────────────────────── */

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

function orList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

export function andList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "today", "this week", "last 7 days". */
export function relRangeText(range: RelRange): string {
  return REL_TEXT[range] ?? humanize(range).toLowerCase();
}

/** The same, reading after a verb: "due this week", "created in the last 7 days". */
function relRangePhrase(range: RelRange): string {
  return /^(last|next)_\d+_days$/.test(range) ? `in the ${relRangeText(range)}` : relRangeText(range);
}

/** "2026-11-01" -> "1 Nov 2026". */
export function dayText(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function numberText(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** "1.5 hours", "1 hour": a duration in its field's stored unit, so the unit a
 * filter ran in is visible. A field whose stored unit isn't settled
 * (FieldCap.unitUncertain: call.duration) shows the bare number. */
function durationText(field: FieldCap, value: number): string {
  if (!field.unit || field.unitUncertain) return numberText(value);
  return `${numberText(value)} ${value === 1 ? field.unit.slice(0, -1) : field.unit}`;
}

/** "₹1,00,000", "$2,500", "AED 2,000"; the plain number when no currency is known. */
export function amountText(value: number, currency: string | null): string {
  const code = currency ? currency.trim().toUpperCase() : '';
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency', currency: code, minimumFractionDigits: 0, maximumFractionDigits: 2,
      }).format(value);
    } catch {
      // Not an ISO currency code: fall through to "CODE 1,000".
    }
  }
  return code ? `${clip(code, 8)} ${numberText(value)}` : numberText(value);
}

function isDateExpr(value: unknown): value is DateExpr {
  return !!value && typeof value === 'object' && ('date' in value || 'rel' in value);
}

/** "1 Nov 2026", "today", "the start of this week". */
function dateValueText(value: number | DateExpr): string {
  if (typeof value === 'number') return numberText(value);
  if ('date' in value) return dayText(value.date);
  if (value.rel === 'today' || value.rel === 'yesterday' || value.rel === 'tomorrow') return relRangeText(value.rel);
  return `the ${value.edge} of ${relRangeText(value.rel)}`;
}

/** "1–15 Nov 2026", "28 Oct – 3 Nov 2026", "today to the end of next week". */
function dateRangeText(from: number | DateExpr, to: number | DateExpr): string {
  if (isDateExpr(from) && isDateExpr(to) && 'date' in from && 'date' in to) {
    const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from.date);
    const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to.date);
    if (a && b && a[1] === b[1]) {
      return a[2] === b[2]
        ? `${Number(a[3])}–${dayText(to.date)}`
        : `${Number(a[3])} ${MONTHS[Number(a[2]) - 1] ?? a[2]} – ${dayText(to.date)}`;
    }
    return `${dayText(from.date)} – ${dayText(to.date)}`;
  }
  return `${dateValueText(from)} to ${dateValueText(to)}`;
}

/* ── Field values ──────────────────────────────────────────────────────── */

function fieldOf(cap: ModuleCap, key: string): FieldCap | undefined {
  return cap.fields.find((f) => f.key === key || f.path === key);
}

function isStatusField(field: FieldCap, status: StatusInfo | null): boolean {
  return field.kind === 'stage' || (!!status && (field.path === status.field || field.key === status.field));
}

function isDateField(field: FieldCap | undefined): boolean {
  return !!field && (field.kind === 'date' || field.kind === 'datetime');
}

/** The currency an amount on this field is in: the branch's Field Service
 * currency, or (deals) the currency the engine pinned next to the amount. */
function currencyOf(field: FieldCap, ctx: ChipContext): string | null {
  const spec = field.money?.currency;
  if (spec === 'fs_branch') return ctx.branchCurrency;
  if (spec && typeof spec === 'object') {
    const pins = [...(ctx.implied ?? []).map((i) => i.cond), ...(ctx.where ?? [])];
    const pinned = pins.find((c) => 'f' in c && c.f === spec.field && c.op === 'eq');
    return pinned && 'v' in pinned && typeof pinned.v === 'string' ? pinned.v : null;
  }
  return null;
}

/** Enum and stage values are words the person can lower-case in a sentence. */
function isWordValue(field: FieldCap | undefined, ctx: ChipContext): boolean {
  return !!field && (field.kind === 'enum' || field.kind === 'boolean' || isStatusField(field, ctx.status));
}

function scalarText(field: FieldCap | undefined, value: unknown, ctx: ChipContext): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field) {
    if (typeof value === 'string' && isStatusField(field, ctx.status)) return ctx.status?.options.get(value)?.label ?? humanize(value);
    if (typeof value === 'string' && field.kind === 'enum') return humanize(value);
    if (field.kind === 'boolean' && (value === 'true' || value === 'false')) return value === 'true' ? 'yes' : 'no';
    if (typeof value === 'number' && field.kind === 'money') return amountText(value, currencyOf(field, ctx));
    if (typeof value === 'number' && field.kind === 'percent') return `${numberText(value)}%`;
    if (typeof value === 'number' && field.kind === 'duration') return durationText(field, value);
  }
  if (typeof value === 'number') return numberText(value);
  if (isDateExpr(value)) return dateValueText(value);
  return clip(String(value ?? ''), 60);
}

/** The part of a field condition after the label: "more than ₹1,00,000", "this week". */
function fieldValueText(field: FieldCap | undefined, cond: Extract<Cond, { f: string }>, ctx: ChipContext): string {
  const date = isDateField(field);
  const value = (v: unknown) => (date && (typeof v === 'number' || isDateExpr(v)) ? dateValueText(v as number | DateExpr) : scalarText(field, v, ctx));
  switch (cond.op) {
    case 'eq': return value(cond.v);
    case 'ne': return `not ${value(cond.v)}`;
    case 'in': return orList(cond.v.map(value));
    case 'nin': return `not ${orList(cond.v.map(value))}`;
    case 'gt': return `${date ? 'after' : 'more than'} ${value(cond.v)}`;
    case 'gte': return `${date ? 'since' : 'at least'} ${value(cond.v)}`;
    case 'lt': return `${date ? 'before' : 'less than'} ${value(cond.v)}`;
    case 'lte': return `${date ? 'until' : 'at most'} ${value(cond.v)}`;
    case 'between': return date ? dateRangeText(cond.v[0], cond.v[1]) : `between ${value(cond.v[0])} and ${value(cond.v[1])}`;
    case 'within': return relRangeText(cond.v);
    case 'contains': return `contains "${clip(cond.v, 40)}"`;
    case 'empty': return 'not set';
    case 'not_empty': return 'set';
    default: return '';
  }
}

function fieldLabel(cap: ModuleCap, key: string): { field: FieldCap | undefined; label: string } {
  const field = fieldOf(cap, key);
  return { field, label: field?.label ?? humanize(key.split('.').pop() ?? key) };
}

/* ── Labels and phrases ────────────────────────────────────────────────── */

/** One condition as a chip label: "Overdue", "Won", "Due: this week". */
export function conditionLabel(cap: ModuleCap, cond: Cond, ctx: ChipContext): string {
  let label: string;
  if (cond.op === 'state') {
    const base = STATE_LABELS[cond.v] ?? humanize(cond.v);
    // "Expiring this month"; with no range of its own, "Expiring in the next 30 days".
    if (cond.v === 'expiring') label = `${base} ${relRangePhrase(cond.range ?? EXPIRING_WINDOW)}`;
    else label = cond.range ? `${base} ${relRangeText(cond.range)}` : base;
  } else if (cond.op === 'outcome') {
    const word = humanize(cond.v);
    label = cond.not ? `Not ${word.toLowerCase()}` : word;
  } else {
    const { field, label: name } = fieldLabel(cap, cond.f);
    label = `${name}: ${fieldValueText(field, cond, ctx)}`;
  }
  return clip(scrubIds(label), MAX_CHIP_LABEL);
}

/** One condition as words after the module name, for interpretedAs:
 * "that are overdue", "due this week", "with amount more than ₹1,00,000". */
export function conditionPhrase(cap: ModuleCap, cond: Cond, ctx: ChipContext): string {
  if (cond.op === 'state') {
    const base = STATE_PHRASES[cond.v] ?? `that are ${humanize(cond.v).toLowerCase()}`;
    if (cond.v === 'expiring') return `${base} ${relRangePhrase(cond.range ?? EXPIRING_WINDOW)}`;
    return cond.range ? `${base} ${relRangePhrase(cond.range)}` : base;
  }
  if (cond.op === 'outcome') return `that are ${cond.not ? 'not ' : ''}${humanize(cond.v).toLowerCase()}`;
  const { field, label } = fieldLabel(cap, cond.f);
  const name = label.toLowerCase();
  if (cond.op === 'empty') return `without ${name}`;
  if (cond.op === 'not_empty') return `with ${name} set`;
  if (cond.op === 'contains') return `with ${name} containing "${clip(cond.v, 40)}"`;
  if (isDateField(field)) {
    const when = cond.op === 'within' ? relRangePhrase(cond.v) : fieldValueText(field, cond, ctx);
    return PARTICIPLE_LABELS.has(name) ? `${name} ${when}` : `with ${name} ${when}`;
  }
  if (field?.kind === 'boolean' && (cond.op === 'eq' || cond.op === 'ne')) {
    // "that are paid", "that are not paid".
    const yes = cond.v === true || cond.v === 'true';
    return `that are ${(cond.op === 'eq') === yes ? '' : 'not '}${name}`;
  }
  const value = fieldValueText(field, cond, ctx);
  return `with ${name} ${isWordValue(field, ctx) ? value.toLowerCase() : value}`;
}

/** What the engine added, as words: "in INR only". */
function impliedPhrase(cap: ModuleCap, implied: ImpliedChip, ctx: ChipContext): string {
  const { cond } = implied;
  if ('f' in cond && cond.op === 'eq' && typeof cond.v === 'string' && /currency/i.test(cond.f)) return `in ${clip(cond.v, 8)} only`;
  return conditionPhrase(cap, cond, ctx);
}

function impliedLabel(cap: ModuleCap, implied: ImpliedChip, ctx: ChipContext): string {
  const { cond } = implied;
  if ('f' in cond && cond.op === 'eq' && typeof cond.v === 'string' && /currency/i.test(cond.f)) {
    return clip(scrubIds(`Currency: ${clip(cond.v, 8)}`), MAX_CHIP_LABEL);
  }
  return conditionLabel(cap, cond, ctx);
}

/** The chips for a table or a count: "mine" first ("Assigned to you"), one
 * per where condition ("w<i>"), the search ("search"), the relation ("rel":
 * `relation`, the words of the plan's relation), then what the engine added
 * ("cur", never removable). `removable` is false where the block can't
 * re-run itself (no handle). */
export function filterChips(
  cap: ModuleCap, plan: QueryPlan, chipCtx: ChipContext, removable: boolean, relation?: RelationWords | null,
): FilterChip[] {
  const ctx: ChipContext = { ...chipCtx, where: plan.where ?? [] };
  const chips: FilterChip[] = plan.mine ? [{ id: 'mine', label: mineLabel(cap, plan.mine), removable }] : [];
  chips.push(...(plan.where ?? []).map((cond, i) => ({ id: `w${i}`, label: conditionLabel(cap, cond, ctx), removable })));
  const search = plan.search?.trim();
  if (search) chips.push({ id: 'search', label: clip(scrubIds(`Search: "${clip(search, 60)}"`), MAX_CHIP_LABEL), removable });
  if (relation) chips.push(relationChip(relation, removable));
  for (const implied of ctx.implied ?? []) {
    chips.push({ id: clip(implied.id, 80), label: impliedLabel(cap, implied, ctx), removable: false });
  }
  return chips.slice(0, 20);
}

/** The plan's conditions as phrases for interpretedAs (search, the relation and implied included). */
export function conditionPhrases(cap: ModuleCap, plan: QueryPlan, chipCtx: ChipContext, relation?: RelationWords | null): string[] {
  const ctx: ChipContext = { ...chipCtx, where: plan.where ?? [] };
  const phrases = (plan.where ?? []).map((cond) => conditionPhrase(cap, cond, ctx));
  const search = plan.search?.trim();
  if (search) phrases.push(`matching "${clip(search, 60)}"`);
  if (relation) phrases.push(relation.phrase);
  for (const implied of ctx.implied ?? []) phrases.push(impliedPhrase(cap, implied, ctx));
  return phrases.map((p) => scrubIds(p)).filter(Boolean);
}

/* ── Relations (Increment 5) ───────────────────────────────────────────── */

/** What a relation adds to the words of an answer (query/relations.ts
 * prepareRelation, outcome 'ready'): its chip ("With invoices", "Without
 * invoices visible to you", "For Acme Industries (ABC123-CUS-0001)"), the
 * same as a phrase for interpretedAs ("with invoices visible to you", "for
 * customer Acme Industries"), and why the answer is partial, in words: the
 * other module's scope is narrower than everything (scope_limited: a
 * customer whose invoices are all hidden from the caller counts as one with
 * none) or too many keys (relation_key_cap). */
export interface RelationWords {
  chip: string;
  phrase: string;
  partialReasons?: PartialReason[];
  /** The partial reasons in words, for the answer's state. */
  partial?: string;
}

type ReadyRelation = Extract<RelationOutcome, { kind: 'ready' }>;

/** The words of a ready relation; null when the plan has none. */
export function relationWords(cap: ModuleCap, rel: ReadyRelation): RelationWords | null {
  const def = rel.relation;
  const asked = rel.plan.relation;
  if (!def || !asked) return null;
  const reasons = [...new Set(rel.extras.partialReasons ?? [])];
  if (asked.kind === 'for') {
    const parent = rel.parent;
    if (!parent) return null;
    const { match } = parent;
    const name = clip(match.number && match.number !== match.label ? `${match.label} (${match.number})` : match.label, 100);
    return {
      chip: clip(scrubIds(`For ${name}`), MAX_CHIP_LABEL),
      phrase: scrubIds(`for ${parent.cap.labels.singular.toLowerCase()} ${name}`),
      ...(reasons.length ? { partialReasons: reasons } : {}),
    };
  }
  const side = rel.related;
  const children = (side?.cap.labels.plural ?? def.child).toLowerCase();
  const visible = side && side.scopeKind !== 'all' ? ' visible to you' : '';
  const where = side?.where ?? [];
  // The related module's own conditions ("customers with overdue invoices"), in its own words.
  const ctx: ChipContext = { status: null, branchCurrency: null, implied: side?.implied ?? [], where };
  const labels = side ? where.map((cond) => conditionLabel(side.cap, cond, ctx)) : [];
  const phrases = side ? where.map((cond) => conditionPhrase(side.cap, cond, ctx)) : [];
  const has = asked.kind === 'has';
  const partial = [
    ...(reasons.includes('scope_limited') ? [`Only ${children} visible to you were checked.`] : []),
    ...(reasons.includes('relation_key_cap')
      ? [`Only the first ${MAX_RELATION_KEYS.toLocaleString('en-US')} ${cap.labels.plural.toLowerCase()} with ${children} were checked.`] : []),
  ];
  return {
    chip: clip(scrubIds(`${has ? 'With' : 'Without'} ${children}${visible}${labels.length ? `: ${labels.join(', ')}` : ''}`), MAX_CHIP_LABEL),
    phrase: scrubIds(`${has ? 'with' : 'without'} ${children}${visible}${phrases.length ? ` ${andList(phrases)}` : ''}`),
    ...(reasons.length ? { partialReasons: reasons } : {}),
    ...(partial.length ? { partial: partial.join(' ') } : {}),
  };
}

/** The relation's chip ("rel"): removable where the block can re-run itself without it. */
export function relationChip(words: RelationWords, removable: boolean): FilterChip {
  return { id: 'rel', label: words.chip, removable };
}

/** A relation as asked, before anything was found (the answer is a notice
 * or a question back): "for customer "Northwind"", "for this work order",
 * "without invoices". */
export function askedRelationPhrase(relation: NonNullable<QueryPlan['relation']>): string {
  const other = getModuleCap(relation.name);
  if (relation.kind === 'for') {
    const singular = (other?.labels.singular ?? 'record').toLowerCase();
    const entity = relation.entity;
    if ('text' in entity) return scrubIds(`for ${singular} "${clip(entity.text.replace(/\s+/g, ' ').replace(/"/g, "'").trim(), 60)}"`);
    return 'focus' in entity ? `for this ${singular}` : `for that ${singular}`;
  }
  const plural = (other?.labels.plural ?? relation.name).toLowerCase();
  return `${relation.kind === 'has' ? 'with' : 'without'} ${plural}`;
}
