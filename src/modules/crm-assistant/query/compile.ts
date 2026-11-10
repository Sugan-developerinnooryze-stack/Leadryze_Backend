import { REL_RANGES } from '../contracts/plan';
import type { Cond, DateExpr, RelRange } from '../contracts/plan';
import type { FieldCap, ModuleCap } from '../registry/types';
import { conditionOpsFor, queryCapsFor, queryStatesFor } from '../registry/query-caps';
import type { CondOp } from '../registry/query-caps';
import type { PlanProblem, PlanProblemCode } from './validate';
import type { StatusInfo } from './execute-list';
import { schemaEnumValues, tenantCurrencies } from './scoped-match';
import type { StatusSpec } from '../../daily-events/daily-events.sources';
import { DAY_MS, addDaysToKey, buildDayWindows, keyStartUtc } from '../../daily-events/daily-events.time';
import type { DateRule } from '../../daily-events/daily-events.time';
import { dayKeyExpression, loadStageInfo } from '../../daily-events/daily-events.query';
import type { StageInfo } from '../../daily-events/daily-events.query';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { parseIsoCalendarDate } from '../../native-crm/shared/date-range';
import { escapeRegex } from '../../../utils/escape-regex';

/* Executor Q's condition compiler: a validated plan's where conditions and
 * search text become Mongo filter fragments that scoped-match.ts places, each
 * as its own member, next to the caller's closed scope object. Nothing is ever
 * dropped silently: every condition either compiles or comes back as a
 * PlanProblem that names it.
 *
 * - Fields: the field must be in the registry entry and conditionOpsFor must
 *   allow the operator; values are coerced to the schema type (finite numbers,
 *   schema enum values, the tenant's pipeline stage keys from peekStages).
 * - Dates match calendar days exactly as Daily Events does: a coarse instant
 *   range on the stored field (so an index can narrow the read) AND the
 *   record's day key (dayKeyExpression with the field's DateRule) compared as
 *   YYYY-MM-DD in the tenant's timezone. Weeks run Monday to Sunday; quarters
 *   are calendar quarters.
 * - States and outcomes follow the stage's terminal flags and tagged outcomes
 *   (loadStageInfo / peekStages; never getOrCreateStages, isValidStageKey or
 *   getOutcomeStageKey, which create PipelineConfig documents).
 * - Amounts are never compared across currencies: a deal amount adds the
 *   caller's FS currency as an implied condition; a Field Service amount needs
 *   one currency in the caller's branch view. */

export interface CompileEnv {
  tenantId: string;
  timezone: string;
  now: Date;
  branchId: string | null;
  /** The module's status labels (loadStatusInfo): the values its stage field may hold. */
  status: StatusInfo | null;
  /** The caller's Field Service currency (getSettings), for amounts compared or ranked. */
  currency: string | null;
}

/** A condition the engine adds on its own (shown as a chip that can't be removed), e.g. the currency next to an amount. */
export interface ImpliedCondition { id: string; cond: Cond; reason: 'currency' }

export interface CompiledWhere { fragments: Record<string, unknown>[]; implied: ImpliedCondition[]; problems: PlanProblem[] }

type Fragment = Record<string, unknown>;
type Built = { fragment: Fragment; money?: FieldCap } | { problem: PlanProblem };

/** The same "cancelled" reading the composer's status tones use (execute-list.ts). */
const CANCELLED_RE = /cancel|lost|reject|disqualif|inactive|retired/i;
/** Same shape the plan contract accepts for a field key (contracts/plan.ts). */
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/;
const MAX_TEXT = 200;
const MONEY_COMPARE_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']);
/** Kinds compared as text (conditionOpsFor allows business refs only). */
const TEXT_KINDS: ReadonlySet<string> = new Set(['id', 'text', 'longtext', 'ref']);

/* ── Small helpers ─────────────────────────────────────────────────────── */

function problem(code: PlanProblemCode, message: string, path?: string): PlanProblem {
  return path ? { code, message, path } : { code, message };
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

export function fieldFor(cap: ModuleCap, key: string): FieldCap | undefined {
  return cap.fields.find((f) => f.key === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && t.length <= MAX_TEXT ? t : null;
}

function boolOf(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function isDateExpr(value: unknown): value is DateExpr {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.date === 'string') return true;
  return keys.length === 2 && typeof value.rel === 'string' && (value.edge === 'start' || value.edge === 'end');
}

function isRelRange(value: unknown): value is RelRange {
  return typeof value === 'string' && (REL_RANGES as readonly string[]).includes(value);
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** The schema value `raw` names: exact, then case-insensitive, then the same
 * words ("in progress" for in_progress), then a stage label; unique matches only. */
function canonicalValue(values: readonly string[], labels: ReadonlyMap<string, string> | null, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (values.includes(v)) return v;
  const unique = (found: string[]) => (found.length === 1 ? found[0] : null);
  const lower = v.toLowerCase();
  const byCase = unique(values.filter((x) => x.toLowerCase() === lower));
  if (byCase) return byCase;
  const byWords = unique(values.filter((x) => norm(x) === norm(v)));
  if (byWords) return byWords;
  if (!labels) return null;
  return unique([...labels].filter(([key, label]) => values.includes(key) && norm(label) === norm(v)).map(([key]) => key));
}

/* ── Dates ─────────────────────────────────────────────────────────────── */

function keyOfUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStartKey(year: number, month0: number): string {
  return keyOfUtc(new Date(Date.UTC(year, month0, 1)));
}

function monthEndKey(year: number, month0: number): string {
  return keyOfUtc(new Date(Date.UTC(year, month0 + 1, 0)));
}

/** Inclusive tenant-local day keys (YYYY-MM-DD) of a relative range; weeks run
 * Monday to Sunday; quarters are calendar quarters. All 17 RelRange values. */
export function resolveRelRange(range: RelRange, timezone: string, now: Date): { fromKey: string; toKey: string } {
  const today = buildDayWindows(timezone, now).todayKey;
  const [year, month] = today.split('-').map(Number);
  const month0 = month - 1;
  const span = (fromKey: string, toKey: string) => ({ fromKey, toKey });
  const monday = addDaysToKey(today, -((keyStartUtc(today).getUTCDay() + 6) % 7));
  const quarter0 = Math.floor(month0 / 3) * 3;
  switch (range) {
    case 'today': return span(today, today);
    case 'yesterday': return span(addDaysToKey(today, -1), addDaysToKey(today, -1));
    case 'tomorrow': return span(addDaysToKey(today, 1), addDaysToKey(today, 1));
    case 'this_week': return span(monday, addDaysToKey(monday, 6));
    case 'last_week': return span(addDaysToKey(monday, -7), addDaysToKey(monday, -1));
    case 'next_week': return span(addDaysToKey(monday, 7), addDaysToKey(monday, 13));
    case 'this_month': return span(monthStartKey(year, month0), monthEndKey(year, month0));
    case 'last_month': return span(monthStartKey(year, month0 - 1), monthEndKey(year, month0 - 1));
    case 'next_month': return span(monthStartKey(year, month0 + 1), monthEndKey(year, month0 + 1));
    case 'this_quarter': return span(monthStartKey(year, quarter0), monthEndKey(year, quarter0 + 2));
    case 'last_quarter': return span(monthStartKey(year, quarter0 - 3), monthEndKey(year, quarter0 - 1));
    case 'this_year': return span(monthStartKey(year, 0), monthEndKey(year, 11));
    case 'last_year': return span(monthStartKey(year - 1, 0), monthEndKey(year - 1, 11));
    case 'last_7_days': return span(addDaysToKey(today, -6), today);
    case 'next_7_days': return span(today, addDaysToKey(today, 6));
    case 'last_30_days': return span(addDaysToKey(today, -29), today);
    case 'next_30_days': return span(today, addDaysToKey(today, 29));
    default: throw new RangeError(`Unknown date range "${String(range)}"`);
  }
}

/** The tenant-local day key a date expression names ({ date } as given, or a
 * relative range's first or last day). Throws RangeError for a date that
 * doesn't exist (2026-02-30) or an unknown range. */
export function dateExprToKey(expr: DateExpr, timezone: string, now: Date): string {
  if ('date' in expr) {
    if (!parseIsoCalendarDate(expr.date)) throw new RangeError(`"${expr.date}" is not a calendar date`);
    return expr.date;
  }
  const range = resolveRelRange(expr.rel, timezone, now);
  return expr.edge === 'start' ? range.fromKey : range.toKey;
}

/** The DateRule a field's stored value is read with (Daily Events). */
export function dateRuleOf(field: FieldCap): DateRule {
  return field.dateRule ?? (field.kind === 'date' ? 'date' : 'instant');
}

/** The record's calendar day (YYYY-MM-DD) under `rule`, computed by the
 * database (dayKeyExpression); null when the stored value isn't a date. */
export function dayKeyOf(path: string, rule: DateRule, timezone: string): Record<string, unknown> {
  return { $cond: [{ $eq: [{ $type: `$${path}` }, 'date'] }, dayKeyExpression(path, rule, timezone), null] };
}

/** Records whose day key is within [fromKey, toKey] (either side optional):
 * the coarse instant range Daily Events uses (keyStartUtc(from) - 1 day to
 * keyStartUtc(to) + 2 days) AND the exact day-key comparison. */
export function dayRangeFragment(path: string, rule: DateRule, timezone: string, fromKey?: string, toKey?: string): Fragment {
  const coarse: Record<string, Date> = {};
  if (fromKey) coarse.$gte = new Date(keyStartUtc(fromKey).getTime() - DAY_MS);
  if (toKey) coarse.$lt = new Date(keyStartUtc(toKey).getTime() + 2 * DAY_MS);
  if (!fromKey && !toKey) return { [path]: { $type: 'date' } };
  const key = dayKeyOf(path, rule, timezone);
  let exact: Record<string, unknown>;
  if (fromKey && toKey && fromKey === toKey) exact = { $eq: [key, fromKey] };
  else {
    const parts: Record<string, unknown>[] = [];
    if (fromKey) parts.push({ $gte: [key, fromKey] });
    if (toKey) parts.push({ $lte: [key, toKey] });
    exact = parts.length === 1 ? parts[0] : { $and: parts };
  }
  return { $and: [{ [path]: coarse }, { $expr: exact }] };
}

/** A group key for a date field: the day key, or the first day (YYYY-MM-DD) of
 * its week (Monday), month, quarter or year, truncated with $dateTrunc from the
 * tenant-local calendar day; null when the record has no date. */
export function dateBucketExpression(path: string, rule: DateRule, timezone: string, bucket: 'day' | 'week' | 'month' | 'quarter' | 'year'): Record<string, unknown> {
  const day = dayKeyOf(path, rule, timezone);
  if (bucket === 'day') return day;
  const asDate = { $dateFromString: { dateString: day, format: '%Y-%m-%d', timezone: 'UTC' } };
  const truncated = { $dateTrunc: { date: asDate, unit: bucket, timezone: 'UTC', ...(bucket === 'week' ? { startOfWeek: 'monday' } : {}) } };
  return { $dateToString: { date: truncated, format: '%Y-%m-%d', timezone: 'UTC' } };
}

/* ── Stages ────────────────────────────────────────────────────────────── */

function enumValuesOf(cap: ModuleCap, field: FieldCap | undefined, path: string): string[] {
  const own = field?.schema?.enumValues;
  return own && own.length ? [...own] : schemaEnumValues(cap, path);
}

/** pipeline -> { field, pipeline }; schema enum -> { field, terminal, cancelled
 * (values reading cancel|lost|reject|disqualif|inactive|retired), labels }. */
export function stageSpecFor(cap: ModuleCap): StatusSpec | null {
  const stage = cap.stage;
  if (!stage) return null;
  if ('pipeline' in stage) return { field: stage.field, pipeline: stage.pipeline };
  const field = cap.fields.find((f) => f.path === stage.field || f.key === stage.field);
  const values = enumValuesOf(cap, field, stage.field);
  return {
    field: stage.field,
    terminal: [...stage.terminal],
    cancelled: values.filter((v) => CANCELLED_RE.test(v)),
    labels: Object.fromEntries(values.map((v) => [v, humanize(v)])),
  };
}

interface StageFacts {
  spec: StatusSpec;
  info: StageInfo;
  /** Values the stage field may hold, with labels. */
  values: ReadonlyMap<string, string>;
}

/** Per compileWhere call: stage facts and tagged outcomes, loaded at most once. */
class Session {
  private facts: Promise<StageFacts | null> | null = null;
  private outcomes: Promise<Map<string, Set<string>>> | null = null;
  private readonly cache = new Map<string, Promise<StageInfo>>();

  constructor(private readonly cap: ModuleCap, readonly env: CompileEnv) {}

  stageFacts(): Promise<StageFacts | null> {
    if (!this.facts) {
      const spec = stageSpecFor(this.cap);
      this.facts = !spec ? Promise.resolve(null) : loadStageInfo(this.env.tenantId, spec, this.cache).then((info) => {
        const labels = 'pipeline' in spec ? info.labels : new Map(Object.entries(spec.labels ?? {}));
        return { spec, info, values: labels };
      });
    }
    return this.facts;
  }

  /** Tagged outcome -> stage keys (pipelines: peekStages, inactive stages included). */
  pipelineOutcomes(): Promise<Map<string, Set<string>>> {
    if (!this.outcomes) {
      const stage = this.cap.stage;
      this.outcomes = !stage || !('pipeline' in stage) ? Promise.resolve(new Map()) : peekStages(this.env.tenantId, stage.pipeline).then((stages) => {
        const map = new Map<string, Set<string>>();
        for (const s of stages ?? []) {
          if (typeof s.outcome !== 'string' || !s.outcome) continue;
          const key = s.outcome.toLowerCase();
          if (!map.has(key)) map.set(key, new Set());
          map.get(key)!.add(s.key);
        }
        return map;
      });
    }
    return this.outcomes;
  }

  /** The values (and labels) a stage or enum field may hold: the module's
   * stage values (env.status when given, else the stage facts), another
   * pipeline field's peekStages keys, or the schema enum. */
  async allowedValues(field: FieldCap): Promise<{ values: string[]; labels: ReadonlyMap<string, string> | null }> {
    const stage = this.cap.stage;
    if (stage && (field.path === stage.field || field.key === stage.field)) {
      const status = this.env.status;
      if (status && status.field === stage.field && status.options.size) {
        return { values: [...status.options.keys()], labels: new Map([...status.options].map(([k, o]) => [k, o.label])) };
      }
      const facts = await this.stageFacts();
      return facts ? { values: [...facts.values.keys()], labels: facts.values } : { values: [], labels: null };
    }
    if (field.kind === 'stage') {
      if (typeof field.enumFrom !== 'object') return { values: [], labels: null };
      const stages = (await peekStages(this.env.tenantId, field.enumFrom.pipeline)) ?? [];
      return { values: stages.map((s) => s.key), labels: new Map(stages.map((s) => [s.key, s.label])) };
    }
    return { values: enumValuesOf(this.cap, field, field.path), labels: null };
  }
}

/* ── Conditions ────────────────────────────────────────────────────────── */

function isCalendarExpr(value: unknown): boolean {
  if (!isDateExpr(value)) return false;
  return 'date' in value ? !!parseIsoCalendarDate(value.date) : isRelRange(value.rel);
}

/** What a field condition's value must look like, checked before any tenant
 * data is read (validate.ts runs it too). Null when the shape fits. */
export function conditionShapeProblem(field: FieldCap, cond: Record<string, unknown>, at: string): PlanProblem | null {
  const op = cond.op;
  const v = cond.v;
  const invalid = (wanted: string) => problem('invalid_value', `${field.label} needs ${wanted}.`, at);
  if (op === 'empty' || op === 'not_empty') return v === undefined ? null : problem('invalid_value', `"${op}" takes no value.`, at);
  switch (field.kind) {
    case 'number': case 'money': case 'percent': case 'duration':
      if (op === 'between') {
        return Array.isArray(v) && v.length === 2 && finiteNumber(v[0]) !== null && finiteNumber(v[1]) !== null ? null : invalid('two numbers');
      }
      return finiteNumber(v) !== null ? null : invalid('a number');
    case 'date': case 'datetime':
      if (op === 'within') return isRelRange(v) ? null : invalid('a date range such as this_week');
      if (op === 'between') return Array.isArray(v) && v.length === 2 && isCalendarExpr(v[0]) && isCalendarExpr(v[1]) ? null : invalid('two dates');
      return isCalendarExpr(v) ? null : invalid('a date');
    case 'boolean':
      return boolOf(v) !== null ? null : invalid('true or false');
    case 'enum': case 'stage':
      if (op === 'in' || op === 'nin') {
        return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0) ? null : invalid('one or more values');
      }
      return typeof v === 'string' && v.trim() ? null : invalid('a value');
    default:
      if (op === 'in' || op === 'nin') return Array.isArray(v) && v.length > 0 && v.every((x) => textOf(x) !== null) ? null : invalid('one or more words');
      return textOf(v) !== null ? null : invalid('some text');
  }
}

function textFragment(path: string, op: CondOp, value: unknown): Fragment | null {
  if (op === 'empty') return { [path]: { $in: [null, ''] } };
  if (op === 'not_empty') return { [path]: { $nin: [null, ''] } };
  if (op === 'contains') {
    const t = textOf(value);
    return t ? { [path]: new RegExp(escapeRegex(t), 'i') } : null;
  }
  if (op === 'eq' || op === 'ne') {
    const t = textOf(value);
    if (!t) return null;
    const exact = new RegExp(`^${escapeRegex(t)}$`, 'i');
    return op === 'eq' ? { [path]: exact } : { [path]: { $not: exact } };
  }
  if (op === 'in' || op === 'nin') {
    if (!Array.isArray(value) || !value.length) return null;
    const texts = value.map(textOf);
    if (texts.some((t) => !t)) return null;
    const patterns = (texts as string[]).map((t) => new RegExp(`^${escapeRegex(t)}$`, 'i'));
    return { [path]: { [op === 'in' ? '$in' : '$nin']: patterns } };
  }
  return null;
}

function numberFragment(path: string, op: CondOp, value: unknown): Fragment | null {
  if (op === 'empty') return { [path]: null };
  if (op === 'not_empty') return { [path]: { $ne: null } };
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const a = finiteNumber(value[0]);
    const b = finiteNumber(value[1]);
    if (a === null || b === null) return null;
    return { [path]: { $gte: Math.min(a, b), $lte: Math.max(a, b) } };
  }
  const n = finiteNumber(value);
  if (n === null) return null;
  switch (op) {
    case 'eq': return { [path]: n };
    case 'ne': return { [path]: { $ne: n } };
    case 'gt': return { [path]: { $gt: n } };
    case 'gte': return { [path]: { $gte: n } };
    case 'lt': return { [path]: { $lt: n } };
    case 'lte': return { [path]: { $lte: n } };
    default: return null;
  }
}

function dateFragment(field: FieldCap, op: CondOp, value: unknown, env: CompileEnv): Fragment | string {
  const path = field.path;
  if (op === 'empty') return { [path]: null };
  if (op === 'not_empty') return { [path]: { $ne: null } };
  const rule = dateRuleOf(field);
  const keyOf = (expr: unknown): string | null => {
    if (!isDateExpr(expr)) return null;
    if ('date' in expr && !parseIsoCalendarDate(expr.date)) return null;
    if ('rel' in expr && !isRelRange(expr.rel)) return null;
    return dateExprToKey(expr, env.timezone, env.now);
  };
  if (op === 'within') {
    if (!isRelRange(value)) return 'a date range such as this_week';
    const { fromKey, toKey } = resolveRelRange(value, env.timezone, env.now);
    return dayRangeFragment(path, rule, env.timezone, fromKey, toKey);
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return 'two dates';
    const a = keyOf(value[0]);
    const b = keyOf(value[1]);
    if (!a || !b) return 'two dates';
    return dayRangeFragment(path, rule, env.timezone, a < b ? a : b, a < b ? b : a);
  }
  const key = keyOf(value);
  if (!key) return 'a date';
  switch (op) {
    case 'gt': return dayRangeFragment(path, rule, env.timezone, addDaysToKey(key, 1), undefined);
    case 'gte': return dayRangeFragment(path, rule, env.timezone, key, undefined);
    case 'lt': return dayRangeFragment(path, rule, env.timezone, undefined, addDaysToKey(key, -1));
    case 'lte': return dayRangeFragment(path, rule, env.timezone, undefined, key);
    default: return 'a date';
  }
}

async function enumFragment(session: Session, cap: ModuleCap, field: FieldCap, op: CondOp, value: unknown, at: string): Promise<Built> {
  const path = field.path;
  if (op === 'empty') return { fragment: { [path]: { $in: [null, ''] } } };
  if (op === 'not_empty') return { fragment: { [path]: { $nin: [null, ''] } } };
  const { values, labels } = await session.allowedValues(field);
  if (!values.length) return { problem: problem('invalid_value', `The values of ${field.label} aren't known.`, at) };
  const what = field.kind === 'stage' || cap.stage?.field === field.path ? `${cap.labels.singular} ${field.label.toLowerCase()}` : field.label.toLowerCase();
  const one = (raw: unknown): string | PlanProblem => {
    const v = canonicalValue(values, labels, raw);
    return v ?? problem('invalid_value', `"${String(raw).slice(0, 60)}" is not a ${what}.`, at);
  };
  if (op === 'eq' || op === 'ne') {
    const v = one(value);
    if (typeof v !== 'string') return { problem: v };
    return { fragment: op === 'eq' ? { [path]: v } : { [path]: { $ne: v } } };
  }
  if (op === 'in' || op === 'nin') {
    if (!Array.isArray(value) || !value.length) return { problem: problem('invalid_value', `${field.label} needs at least one value.`, at) };
    const out: string[] = [];
    for (const raw of value) {
      const v = one(raw);
      if (typeof v !== 'string') return { problem: v };
      if (!out.includes(v)) out.push(v);
    }
    return { fragment: { [path]: { [op === 'in' ? '$in' : '$nin']: out } } };
  }
  return { problem: problem('unsupported_condition', `${field.label} can't be filtered with "${op}".`, at) };
}

async function fieldCondition(session: Session, cap: ModuleCap, cond: Record<string, unknown>, at: string): Promise<Built> {
  const key = cond.f;
  if (typeof key !== 'string' || !key) return { problem: problem('invalid_plan', 'A condition needs a field.', at) };
  if (key.includes('$') || !FIELD_KEY_RE.test(key)) return { problem: problem('invalid_plan', `"${key.slice(0, 80)}" is not a field name.`, at) };
  const field = fieldFor(cap, key);
  if (!field) {
    return {
      problem: problem('unsupported_condition', key.includes('.')
        ? `${cap.labels.plural} have no field "${key}".`
        : `${cap.labels.plural} can't be filtered by "${key}".`, at),
    };
  }
  const op = cond.op as CondOp;
  const ops = conditionOpsFor(cap, field);
  if (!ops.includes(op)) {
    return {
      problem: problem('unsupported_condition', ops.length
        ? `${field.label} can't be filtered with "${String(cond.op)}".`
        : `${cap.labels.plural} can't be filtered by ${field.label.toLowerCase()}.`, at),
    };
  }
  const shape = conditionShapeProblem(field, cond, at);
  if (shape) return { problem: shape };
  const value = cond.v;
  const invalid = (wanted: string) => ({ problem: problem('invalid_value', `${field.label} needs ${wanted}.`, at) });

  switch (field.kind) {
    case 'number': case 'money': case 'percent': case 'duration': {
      const fragment = numberFragment(field.path, op, value);
      if (!fragment) return invalid(op === 'between' ? 'two numbers' : 'a number');
      return { fragment, ...(field.kind === 'money' && MONEY_COMPARE_OPS.has(op) ? { money: field } : {}) };
    }
    case 'date': case 'datetime': {
      const built = dateFragment(field, op, value, session.env);
      return typeof built === 'string' ? invalid(built) : { fragment: built };
    }
    case 'enum': case 'stage':
      return enumFragment(session, cap, field, op, value, at);
    case 'boolean': {
      const b = boolOf(value);
      if (b === null) return invalid('true or false');
      return { fragment: op === 'eq' ? { [field.path]: b } : { [field.path]: { $ne: b } } };
    }
    default: {
      if (!TEXT_KINDS.has(field.kind)) return { problem: problem('unsupported_condition', `${cap.labels.plural} can't be filtered by ${field.label.toLowerCase()}.`, at) };
      const fragment = textFragment(field.path, op, value);
      if (!fragment) return invalid(op === 'in' || op === 'nin' ? 'one or more words' : 'some text');
      return { fragment };
    }
  }
}

/** open = stage not terminal (+ the module's openFilter); closed = the rest. */
function openFragment(field: string, terminal: ReadonlySet<string>, openFilter: Record<string, unknown> | undefined): Fragment {
  const open: Fragment = { ...(openFilter ?? {}) };
  if (terminal.size) open[field] = { $nin: [...terminal] };
  return open;
}

function closedFragment(field: string, terminal: ReadonlySet<string>, openFilter: Record<string, unknown> | undefined): Fragment {
  const finished: Fragment = { [field]: { $in: [...terminal] } };
  return openFilter && Object.keys(openFilter).length ? { $or: [finished, { $nor: [{ ...openFilter }] }] } : finished;
}

/** expiring (QueryCaps.expiring): the end date's day key in the window (the
 * plan's range, else the next 30 days), with the field's DateRule as Daily
 * Events reads it, and the record still running: in a stage tagged with the
 * 'active' outcome (the key 'active' when the tenant tagged none, as the
 * contract visit scheduler and Daily Events read running contracts), or in
 * any stage that isn't terminal; and `also`. */
async function expiringFragment(
  session: Session, cap: ModuleCap, range: unknown, field: string, terminal: ReadonlySet<string>, at: string,
): Promise<Built> {
  const qc = queryCapsFor(cap.key);
  const spec = qc?.expiring;
  if (!spec) return { problem: problem('unsupported_condition', `${cap.labels.plural} can't be filtered as expiring.`, at) };
  if (range !== undefined && !isRelRange(range)) return { problem: problem('invalid_value', 'The window needs a date range such as this_month.', at) };
  const { fromKey, toKey } = resolveRelRange(range ?? 'next_30_days', session.env.timezone, session.env.now);
  let running: Fragment;
  if (spec.running === 'active') {
    const active = (await session.pipelineOutcomes()).get('active');
    running = { [field]: { $in: active?.size ? [...active] : ['active'] } };
  } else {
    running = openFragment(field, terminal, qc.openFilter);
  }
  return {
    fragment: { $and: [dayRangeFragment(spec.field, spec.rule, session.env.timezone, fromKey, toKey), running, ...(spec.also ? [{ ...spec.also }] : [])] },
  };
}

async function stateCondition(session: Session, cap: ModuleCap, cond: Record<string, unknown>, at: string): Promise<Built> {
  const v = cond.v;
  // Only "expiring" takes a window ("contracts expiring this month").
  if (cond.range !== undefined && v !== 'expiring') return { problem: problem('unsupported_condition', 'A date range on a record state is not supported yet.', at) };
  const states = queryStatesFor(cap);
  const supported = v === 'open' ? states.open : v === 'closed' ? states.closed : v === 'overdue' ? states.overdue
    : v === 'due_today' ? states.dueToday : v === 'expiring' ? states.expiring : undefined;
  if (supported === undefined) return { problem: problem('invalid_plan', `Unknown state "${String(v).slice(0, 40)}".`, at) };
  if (!supported) {
    const word = v === 'due_today' ? 'due today' : String(v);
    return { problem: problem('unsupported_condition', `${cap.labels.plural} can't be filtered as ${word}.`, at) };
  }
  const facts = await session.stageFacts();
  if (!facts) return { problem: problem('unsupported_condition', `${cap.labels.plural} have no stage.`, at) };
  const qc = queryCapsFor(cap.key)!;
  const field = facts.spec.field;
  const terminal = facts.info.terminal;
  if (v === 'open') return { fragment: openFragment(field, terminal, qc.openFilter) };
  if (v === 'closed') return { fragment: closedFragment(field, terminal, qc.openFilter) };
  if (v === 'expiring') return expiringFragment(session, cap, cond.range, field, terminal, at);

  const due = qc.due!;
  const tz = session.env.timezone;
  const todayKey = buildDayWindows(tz, session.env.now).todayKey;
  const open = openFragment(field, terminal, qc.openFilter);
  if (v === 'due_today') return { fragment: { $and: [dayRangeFragment(due.field, due.rule, tz, todayKey, todayKey), open] } };
  // overdue: due before today (Daily Events' coarse range and day match), still open.
  const overdue: Fragment = {
    $and: [
      { [due.field]: { $lt: new Date(keyStartUtc(todayKey).getTime() + 2 * DAY_MS) } },
      { $expr: { $lt: [dayKeyOf(due.field, due.rule, tz), todayKey] } },
    ],
  };
  return { fragment: { $and: [overdue, open, ...(due.overdueExtra ? [{ ...due.overdueExtra }] : [])] } };
}

async function outcomeCondition(session: Session, cap: ModuleCap, cond: Record<string, unknown>, at: string): Promise<Built> {
  const raw = cond.v;
  if (typeof raw !== 'string' || !raw.trim()) return { problem: problem('invalid_value', 'An outcome needs a name.', at) };
  if (cond.not !== undefined && typeof cond.not !== 'boolean') return { problem: problem('invalid_plan', '"not" must be true or false.', at) };
  const outcome = raw.trim().toLowerCase();
  const facts = await session.stageFacts();
  if (!facts) return { problem: problem('unsupported_condition', `${cap.labels.plural} have no stage, so no outcomes.`, at) };
  const keys = new Set<string>();
  if ('pipeline' in facts.spec) {
    for (const key of (await session.pipelineOutcomes()).get(outcome) ?? []) keys.add(key);
  } else {
    // Schema enums tag no outcomes: a terminal value with that name stands for it.
    for (const key of facts.info.terminal) if (key.toLowerCase() === outcome) keys.add(key);
  }
  if (outcome === 'cancelled') for (const key of facts.info.cancelled) keys.add(key);
  if (!keys.size) return { problem: problem('invalid_value', `${cap.labels.plural} have no "${raw.trim().slice(0, 40)}" outcome here.`, at) };
  return { fragment: { [facts.spec.field]: { [cond.not === true ? '$nin' : '$in']: [...keys] } } };
}

/* ── Currency ──────────────────────────────────────────────────────────── */

/** True when the plan itself keeps one currency ("currency eq USD"). */
function pinsCurrency(where: readonly unknown[] | undefined, currencyField: string): boolean {
  return (where ?? []).some((c) => isRecord(c) && c.f === currencyField && c.op === 'eq');
}

/** Amounts are never compared or ranked across currencies. For each money field
 * compared (or sorted by): a field with its own currency field (deal amount)
 * adds the caller's FS currency as an implied condition (id 'cur') unless the
 * plan already pins one currency; a Field Service amount ('fs_branch') needs a
 * branch, or a tenant whose companies all use one currency. */
export async function currencyRules(
  cap: ModuleCap, fields: readonly FieldCap[], where: readonly Cond[] | undefined, env: CompileEnv,
): Promise<{ fragments: Fragment[]; implied: ImpliedCondition[]; problems: PlanProblem[] }> {
  const fragments: Fragment[] = [];
  const implied: ImpliedCondition[] = [];
  const problems: PlanProblem[] = [];
  const done = new Set<string>();
  for (const field of fields) {
    const spec = field.money?.currency;
    if (!spec || spec === 'none') continue;
    if (spec === 'fs_branch') {
      if (done.has('fs_branch')) continue;
      done.add('fs_branch');
      if (env.branchId) continue;
      if ((await tenantCurrencies(env.tenantId)).length > 1) {
        problems.push(problem('unsupported_condition', 'Amounts are in different currencies across your companies; pick a company to compare amounts.'));
      }
      continue;
    }
    const currencyField = spec.field;
    if (done.has(currencyField)) continue;
    done.add(currencyField);
    if (pinsCurrency(where, currencyField)) continue;
    if (!env.currency) {
      problems.push(problem('unsupported_condition', `The currency for ${cap.labels.singular.toLowerCase()} amounts isn't known right now, so amounts can't be compared.`));
      continue;
    }
    const fragment = textFragment(fieldFor(cap, currencyField)?.path ?? currencyField, 'eq', env.currency);
    if (!fragment) { problems.push(problem('invalid_value', 'The currency for amounts is not valid.')); continue; }
    implied.push({ id: 'cur', cond: { f: currencyField, op: 'eq', v: env.currency }, reason: 'currency' });
    fragments.push(fragment);
  }
  return { fragments, implied, problems };
}

/** The money fields a plan's conditions compare (eq, ne, gt, gte, lt, lte, between). */
export function comparedMoneyFields(cap: ModuleCap, where: readonly Cond[] | undefined): FieldCap[] {
  const out: FieldCap[] = [];
  for (const raw of where ?? []) {
    const cond: unknown = raw;
    if (!isRecord(cond) || typeof cond.f !== 'string' || !MONEY_COMPARE_OPS.has(String(cond.op))) continue;
    const field = fieldFor(cap, cond.f);
    if (field?.kind === 'money' && !out.includes(field)) out.push(field);
  }
  return out;
}

/* ── Entry points ──────────────────────────────────────────────────────── */

export async function compileWhere(cap: ModuleCap, where: Cond[] | undefined, env: CompileEnv): Promise<CompiledWhere> {
  const fragments: Fragment[] = [];
  const problems: PlanProblem[] = [];
  const money: FieldCap[] = [];
  const session = new Session(cap, env);
  const conds: unknown[] = Array.isArray(where) ? where : [];
  if (where !== undefined && !Array.isArray(where)) problems.push(problem('invalid_plan', 'where must be a list of conditions.', 'where'));

  for (let i = 0; i < conds.length; i += 1) {
    const at = `where.${i}`;
    const cond = conds[i];
    let built: Built;
    if (!isRecord(cond)) built = { problem: problem('invalid_plan', 'A condition must be an object.', at) };
    else if (cond.op === 'state') built = await stateCondition(session, cap, cond, at);
    else if (cond.op === 'outcome') built = await outcomeCondition(session, cap, cond, at);
    else if ('f' in cond) built = await fieldCondition(session, cap, cond, at);
    else built = { problem: problem('invalid_plan', 'A condition needs a field or a state.', at) };

    if ('problem' in built) { problems.push(built.problem); continue; }
    fragments.push(built.fragment);
    if (built.money && !money.includes(built.money)) money.push(built.money);
  }

  const currency = await currencyRules(cap, money, Array.isArray(where) ? where : undefined, env);
  return {
    fragments: [...fragments, ...currency.fragments],
    implied: currency.implied,
    problems: [...problems, ...currency.problems],
  };
}

/** Escaped (backend/src/utils/escape-regex.ts), case-insensitive $or over
 * queryCaps.searchFields; null when the text is blank. A module with no search
 * fields matches nothing rather than ignoring the text. */
export function compileSearch(cap: ModuleCap, text: string | undefined): Record<string, unknown> | null {
  const t = typeof text === 'string' ? text.trim().slice(0, 100) : '';
  if (!t) return null;
  const fields = queryCapsFor(cap.key)?.searchFields ?? [];
  if (!fields.length) return { _id: { $in: [] } };
  return { $or: fields.map((path) => ({ [path]: new RegExp(escapeRegex(t), 'i') })) };
}
