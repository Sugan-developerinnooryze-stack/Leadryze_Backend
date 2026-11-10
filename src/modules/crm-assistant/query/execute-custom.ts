import { QueryPlanSchema, REL_RANGES } from '../contracts/plan';
import type { Cond, DateExpr, QueryPlan, RelRange } from '../contracts/plan';
import type { CondOp } from '../registry/query-caps';
import { customFieldFor, customModuleStillDefined } from '../registry/custom-modules';
import type { CustomFieldInfo, CustomModuleInfo } from '../registry/custom-modules';
import { businessNumberOf } from './validate';
import type { PlanProblem, PlanProblemCode } from './validate';
import { MAX_QUERY_GROUPS, PlanRejectedError } from './execute-query';
import type { GroupRow } from './execute-query';
import { dateExprToKey, dayRangeFragment, resolveRelRange } from './compile';
import { customCount, customFind, customFindByKey, customGroup, customGroupCount } from './custom-match';
import { addDaysToKey } from '../../daily-events/daily-events.time';
import { isValidTimeZone, parseIsoCalendarDate } from '../../native-crm/shared/date-range';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../internal/crm-gateway.helpers';
import { escapeRegex } from '../../../utils/escape-regex';

/* Executor M (Increment 5, LD5): one Custom Module's records, read through
 * custom-match.ts. Lists (escaped search, conditions, a sort by a field or
 * newest first, always with _id as tie-breaker, pages of 10 and at most 25),
 * counts, and counts by a dropdown or yes/no field. No record detail (the app
 * has no record page), no "mine", no relations, no date windows.
 *
 * validateCustomPlan checks a plan against the module's current definition
 * (registry/custom-modules.ts) before anything runs, names every problem and
 * returns the plan with each value as stored (a dropdown option as defined, a
 * record number in upper case). The executors check it again (a plan is never
 * run on trust) and throw PlanRejectedError, the same refusal executor Q
 * throws, for anything they can't run.
 *
 * Values are compared as the screens store them: blank optional values are
 * empty strings, so "empty" covers '', null and missing (and [] for a
 * multi-select); a yes/no field never touched holds '' (or nothing) and the
 * form shows it as "No", so "no" is false, '', null or missing and "yes" only
 * true (a value of another type is neither), while "not set" still means
 * anything but a real yes or no; dates are "YYYY-MM-DD" and date-times local
 * "YYYY-MM-DDTHH:mm" strings, compared as strings by their calendar day with
 * the day keys of the tenant's timezone (only values that start with a day
 * key take part). The record's own creation date is a stored Date and follows
 * Daily Events' calendar days (compile.ts dayRangeFragment). A sort by a field
 * orders by the values of the field's own type (sortKeyOf): a blank amount
 * never ranks above the real ones. A list, its count
 * and its breakdown are built from the same conditions, so a count equals its
 * list's total. Rows carry only the fields the table shows, read from the
 * current definition: tenantId, clientId, moduleSlug, createdBy and __v are
 * never read. A read that finds no records first confirms the module is still
 * defined (the definitions are cached 60 s): one deleted since comes back
 * marked moduleGone, so the answer says so instead of a zero. */

export interface CustomExecContext {
  tenantId: string;
  /** The tenant's timezone (relative dates and calendar days). */
  timezone: string;
  /** Clock for date windows (tests pass a fixed one). Default new Date(). */
  now?: Date;
}

/** One record as read: only the fields the table shows (CustomModuleInfo.columns and titleFields). */
export interface CustomRecordRow {
  id: string | null;
  recordId: string | null;
  createdAt: Date | null;
  /** By the definition's own field key. */
  data: Record<string, unknown>;
}

export interface CustomListOutcome {
  items: CustomRecordRow[];
  total: number;
  page: number;
  size: number;
  /** The sort that ran: plan.sort, else createdAt descending. */
  sort: { by: string; dir: 'asc' | 'desc' };
  /** No records, because the module was deleted since its definition was cached. */
  moduleGone?: true;
}

export interface CustomCountOutcome {
  /** null when the count isn't a number, never 0. */
  total: number | null;
  /** A count of 0, because the module was deleted since its definition was cached. */
  moduleGone?: true;
}

export interface CustomGroupsOutcome {
  /** Most first, at most MAX_QUERY_GROUPS; key null = not set. */
  groups: GroupRow[];
  /** Every group the conditions make, however many come back. */
  totalGroups: number;
  total: number;
  /** No records, because the module was deleted since its definition was cached. */
  moduleGone?: true;
}

export type CustomOutcome =
  | { op: 'list'; result: CustomListOutcome }
  | ({ op: 'count' } & CustomCountOutcome)
  | { op: 'aggregate'; result: CustomGroupsOutcome };

export type CustomPlanValidation =
  | { ok: true; plan: QueryPlan; info: CustomModuleInfo }
  | { ok: false; problems: PlanProblem[] };

/** A table's change asked through POST /view (contracts/views.ts ViewActionRequest, without the handle). */
export interface CustomViewChange {
  page?: number;
  sort?: { key: string; dir: 'asc' | 'desc' };
  removeFilter?: string;
}

export type CustomViewChangeResult =
  | { ok: true; plan: QueryPlan }
  | { ok: false; code: 'not_rerunnable' | 'filter_not_removable' | 'not_sortable'; message: string };

type Fragment = Record<string, unknown>;
type FieldCond = Extract<Cond, { f: string }>;
type Checked = { cond: FieldCond } | { problem: PlanProblem };

interface CompileEnv { timezone: string; now: Date }

/** Plan keys executor M never runs (ignoring one would change which records are read). */
const UNSUPPORTED_KEYS: ReadonlyArray<[keyof QueryPlan, string]> = [
  ['mine', 'can\'t be narrowed to yours yet'],
  ['relation', 'can\'t be read with related records yet'],
  ['window', 'can\'t be read by a date window yet'],
  ['record', 'have no record page to open here; ask for a list instead'],
];
/** Plan keys a count breakdown can't be combined with (groups are not paged or re-sorted). */
const AGGREGATE_EXCLUDED_KEYS: ReadonlyArray<keyof QueryPlan> = ['sort', 'top', 'page', 'pageSize'];
const MAX_TEXT = 200;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/* ── Small helpers ─────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function problem(code: PlanProblemCode, path: string, message: string): PlanProblem {
  return { code, path, message };
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

function isRelRange(value: unknown): value is RelRange {
  return typeof value === 'string' && (REL_RANGES as readonly string[]).includes(value);
}

/** { date } of a real calendar day, or { rel, edge } of a known range. */
function isCalendarExpr(value: unknown): value is DateExpr {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.date === 'string') return DAY_KEY.test(value.date) && !!parseIsoCalendarDate(value.date);
  return keys.length === 2 && isRelRange(value.rel) && (value.edge === 'start' || value.edge === 'end');
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** The option `raw` names: exact, then the only one matching without case, then the only one with the same words. */
function optionOf(options: readonly string[], raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (options.includes(raw)) return raw;
  const v = raw.trim();
  if (options.includes(v)) return v;
  const unique = (found: string[]) => (found.length === 1 ? found[0] : null);
  return unique(options.filter((o) => o.toLowerCase() === v.toLowerCase())) ?? unique(options.filter((o) => norm(o) === norm(v)));
}

/* ── Conditions ────────────────────────────────────────────────────────── */

/** One where condition checked against the field and returned with its value
 * as stored, or the problem that stops it. Needs no tenant data. */
function checkCondition(info: CustomModuleInfo, raw: unknown, at: string): Checked {
  const fail = (code: PlanProblemCode, message: string, path = at): Checked => ({ problem: problem(code, path, message) });
  if (!isRecord(raw)) return fail('invalid_plan', 'A condition must be an object.');
  if (raw.op === 'state') return fail('unsupported_condition', `${info.name} can't be filtered as ${String(raw.v).replace('_', ' ')}.`);
  if (raw.op === 'outcome') return fail('unsupported_condition', `${info.name} have no outcomes.`);
  const key = raw.f;
  if (typeof key !== 'string' || !key) return fail('invalid_plan', 'A condition needs a field.');
  const field = customFieldFor(info, key);
  if (!field) return fail('unsupported_condition', `${info.name} can't be filtered by "${key.slice(0, 80)}".`, `${at}.f`);
  const op = raw.op as CondOp;
  const f = field.key;
  const valueOp = op !== 'empty' && op !== 'not_empty';
  const byName = (): Checked => fail('unsupported_option',
    `${field.label} is matched by the record number it holds; finding it by name isn't supported yet.`, `${at}.v`);
  // A relationship holds the stored id of the record it points to, never its
  // name: a name would be compared with ids and match nothing (a confident
  // zero). Only a target that stores record numbers can be matched by a value.
  if (field.fieldType === 'relationship' && valueOp && !field.refModule) return byName();
  if (!field.ops.includes(op)) {
    return fail('unsupported_condition', field.ops.length
      ? `${field.label} can't be filtered with "${String(raw.op).slice(0, 20)}".`
      : `${info.name} can't be filtered by ${field.label.toLowerCase()}.`, `${at}.op`);
  }
  if (!valueOp) return raw.v === undefined ? { cond: { f, op } as FieldCond } : fail('invalid_value', `"${op}" takes no value.`, `${at}.v`);

  const v = raw.v;
  const invalid = (wanted: string): Checked => fail('invalid_value', `${field.label} needs ${wanted}.`, `${at}.v`);
  // in / nin take a list of values (between a pair), every other operator one value.
  const listOp = op === 'in' || op === 'nin' || op === 'between';
  if (Array.isArray(v) !== listOp || (Array.isArray(v) && !v.length)) return invalid(listOp ? 'a list of values' : 'one value');
  switch (field.kind) {
    case 'number': {
      if (op === 'between') {
        const a = Array.isArray(v) && v.length === 2 ? finiteNumber(v[0]) : null;
        const b = Array.isArray(v) && v.length === 2 ? finiteNumber(v[1]) : null;
        return a !== null && b !== null ? { cond: { f, op, v: [a, b] } } : invalid('two numbers');
      }
      const n = finiteNumber(v);
      return n === null ? invalid('a number') : { cond: { f, op, v: n } as FieldCond };
    }
    case 'date': case 'datetime': {
      if (op === 'within') return isRelRange(v) ? { cond: { f, op, v } } : invalid('a date range such as this_week');
      if (op === 'between') {
        return Array.isArray(v) && v.length === 2 && isCalendarExpr(v[0]) && isCalendarExpr(v[1]) ? { cond: { f, op, v: [v[0], v[1]] } } : invalid('two dates');
      }
      return isCalendarExpr(v) ? { cond: { f, op, v } as FieldCond } : invalid('a date');
    }
    case 'boolean': {
      const b = boolOf(v);
      return b === null ? invalid('yes or no') : { cond: { f, op, v: b } as FieldCond };
    }
    case 'enum': case 'multi': {
      const options = field.options ?? [];
      const one = (value: unknown): string | Checked => optionOf(options, value)
        ?? fail('invalid_value', `"${String(value).slice(0, 60)}" is not one of the ${field.label} values.`, `${at}.v`);
      if (op === 'in' || op === 'nin') {
        const out: string[] = [];
        for (const value of v as unknown[]) {
          const found = one(value);
          if (typeof found !== 'string') return found;
          if (!out.includes(found)) out.push(found);
        }
        return { cond: { f, op, v: out } as FieldCond };
      }
      const found = one(v);
      return typeof found === 'string' ? { cond: { f, op, v: found } as FieldCond } : found;
    }
    default: {
      if (field.refModule) {
        // Each value must be one of the target module's record numbers, kept as the models store it.
        const values: unknown[] = Array.isArray(v) ? v : [v];
        const numbers = values.map((value) => (typeof value === 'string' ? businessNumberOf(value) : null));
        if (!numbers.every((n) => n?.module === field.refModule)) return byName();
        const stored = numbers.map((n) => n!.number);
        return { cond: { f, op, v: Array.isArray(v) ? stored : stored[0] } as FieldCond };
      }
      if (op === 'in' || op === 'nin') {
        const texts = (v as unknown[]).map(textOf);
        return texts.every((t) => t !== null) ? { cond: { f, op, v: texts as string[] } as FieldCond } : invalid('one or more words');
      }
      const t = textOf(v);
      return t === null ? invalid('some text') : { cond: { f, op, v: t } as FieldCond };
    }
  }
}

function emptyValues(field: CustomFieldInfo): unknown[] {
  return field.kind === 'multi' ? [null, '', []] : [null, ''];
}

/** Only values that start with a day key ("2026-11-01", "2026-11-01T09:30")
 * take part, compared as strings: from the first day's key to before the day
 * after the last. */
function stringDayRange(path: string, fromKey?: string, toKey?: string): Fragment {
  const range: Record<string, unknown> = { $regex: /^\d{4}-\d{2}-\d{2}/ };
  if (fromKey) range.$gte = fromKey;
  if (toKey) range.$lt = addDaysToKey(toKey, 1);
  return { [path]: range };
}

function dateFragment(field: CustomFieldInfo, cond: FieldCond, env: CompileEnv): Fragment {
  const keyOf = (expr: unknown) => dateExprToKey(expr as DateExpr, env.timezone, env.now);
  let fromKey: string | undefined;
  let toKey: string | undefined;
  switch (cond.op) {
    case 'within': ({ fromKey, toKey } = resolveRelRange(cond.v, env.timezone, env.now)); break;
    case 'between': {
      const a = keyOf(cond.v[0]);
      const b = keyOf(cond.v[1]);
      fromKey = a < b ? a : b;
      toKey = a < b ? b : a;
      break;
    }
    case 'gt': fromKey = addDaysToKey(keyOf(cond.v), 1); break;
    case 'gte': fromKey = keyOf(cond.v); break;
    case 'lt': toKey = addDaysToKey(keyOf(cond.v), -1); break;
    case 'lte': toKey = keyOf(cond.v); break;
    default: throw new Error(`Unexpected date operator "${cond.op}"`);
  }
  // The creation date is a stored Date: Daily Events' calendar day of the instant.
  return field.system ? dayRangeFragment(field.path, 'instant', env.timezone, fromKey, toKey) : stringDayRange(field.path, fromKey, toKey);
}

function textFragment(path: string, cond: FieldCond): Fragment {
  const exact = (value: unknown) => new RegExp(`^${escapeRegex(String(value))}$`, 'i');
  switch (cond.op) {
    case 'contains': return { [path]: new RegExp(escapeRegex(String(cond.v)), 'i') };
    case 'eq': return { [path]: exact(cond.v) };
    case 'ne': return { [path]: { $not: exact(cond.v) } };
    case 'in': return { [path]: { $in: cond.v.map(exact) } };
    case 'nin': return { [path]: { $nin: cond.v.map(exact) } };
    default: throw new Error(`Unexpected text operator "${cond.op}"`);
  }
}

/** The Mongo fragment of a checked condition (checkCondition). */
function fragmentOf(field: CustomFieldInfo, cond: FieldCond, env: CompileEnv): Fragment {
  const path = field.path;
  if (field.kind === 'boolean' && (cond.op === 'empty' || cond.op === 'not_empty')) {
    // Never touched: '' (or nothing); only a real yes or no counts as set.
    return { [path]: { [cond.op === 'empty' ? '$nin' : '$in']: [true, false] } };
  }
  if (field.kind === 'boolean' && (cond.op === 'eq' || cond.op === 'ne')) {
    // The form shows "No" for false and for a toggle never touched ('', null
    // or a missing key, which $in's null also matches), so "no" is all of
    // them and "yes" only true; a value of another type is neither. "Not yes"
    // is "no" and "not no" is "yes": both wordings count the same records.
    return (cond.op === 'eq') === (cond.v === true) ? { [path]: true } : { [path]: { $in: [false, '', null] } };
  }
  if (cond.op === 'empty') return { [path]: { $in: emptyValues(field) } };
  if (cond.op === 'not_empty') return { [path]: { $nin: emptyValues(field) } };
  if (field.kind === 'date' || field.kind === 'datetime') return dateFragment(field, cond, env);
  if (field.kind === 'text' && !field.refModule) return textFragment(path, cond);
  // Numbers, yes/no, dropdown options and record numbers: exact values (a
  // multi-select matches when it holds the value, or any of the values).
  switch (cond.op) {
    case 'eq': return { [path]: cond.v };
    case 'ne': return { [path]: { $ne: cond.v } };
    case 'in': return { [path]: { $in: cond.v } };
    case 'nin': return { [path]: { $nin: cond.v } };
    case 'gt': return { [path]: { $gt: cond.v } };
    case 'gte': return { [path]: { $gte: cond.v } };
    case 'lt': return { [path]: { $lt: cond.v } };
    case 'lte': return { [path]: { $lte: cond.v } };
    case 'between': {
      const [a, b] = cond.v as [number, number];
      return { [path]: { $gte: Math.min(a, b), $lte: Math.max(a, b) } };
    }
    default: throw new Error(`Unexpected operator "${cond.op}"`);
  }
}

/** The plan's where conditions as Mongo fragments, or the problems that stop them. */
export function compileCustomWhere(
  info: CustomModuleInfo, where: readonly Cond[] | undefined, env: CompileEnv,
): { fragments: Fragment[]; problems: PlanProblem[] } {
  const fragments: Fragment[] = [];
  const problems: PlanProblem[] = [];
  (where ?? []).forEach((raw, i) => {
    const checked = checkCondition(info, raw, `where.${i}`);
    if ('problem' in checked) { problems.push(checked.problem); return; }
    fragments.push(fragmentOf(customFieldFor(info, checked.cond.f)!, checked.cond, env));
  });
  return { fragments, problems };
}

/** Escaped (backend/src/utils/escape-regex.ts), case-insensitive $or over the
 * module's text fields and the record number; null when the text is blank. */
export function compileCustomSearch(info: CustomModuleInfo, text: string | undefined): Fragment | null {
  const t = typeof text === 'string' ? text.trim().slice(0, 100) : '';
  if (!t) return null;
  const paths = [...info.fields.filter((f) => f.searchable).map((f) => f.path), 'recordId'];
  return { $or: paths.map((path) => ({ [path]: new RegExp(escapeRegex(t), 'i') })) };
}

/* ── Validation ────────────────────────────────────────────────────────── */

/** A plan for this Custom Module checked against its current definition: the
 * plan with its values as stored (and top N as the page size), or every
 * problem, named. Codes as validate.ts: unsupported_op / unsupported_option
 * for what executor M can't run yet (detail, "mine", relations, date windows,
 * metrics), unsupported_condition / invalid_value for a condition the
 * definition doesn't allow, unknown_module for another module's plan. */
export function validateCustomPlan(input: unknown, info: CustomModuleInfo): CustomPlanValidation {
  const parsed = QueryPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 5).map((issue) => problem('invalid_plan', issue.path.join('.'),
        `Plan ${issue.path.join('.') || '(root)'}: ${issue.message}`)),
    };
  }
  const plan = parsed.data;
  if (!('module' in plan.target) || plan.target.module !== info.key) {
    return { ok: false, problems: [problem('unknown_module', 'target.module', `Not a plan for ${info.name}.`)] };
  }

  const problems: PlanProblem[] = [];
  const push = (code: PlanProblemCode, path: string, message: string) => problems.push(problem(code, path, message));
  if (plan.op === 'detail' || plan.op === 'agenda') {
    push('unsupported_op', 'op', plan.op === 'detail'
      ? `${info.name} have no record page to open here; ask for a list instead.`
      : `"${plan.op}" is not supported for ${info.name}.`);
  }
  for (const [key, what] of UNSUPPORTED_KEYS) {
    if (plan[key] !== undefined) push('unsupported_option', key, `${info.name} ${what}.`);
  }

  const where: Cond[] = [];
  (plan.where ?? []).forEach((raw, i) => {
    const checked = checkCondition(info, raw, `where.${i}`);
    if ('problem' in checked) problems.push(checked.problem);
    else where.push(checked.cond);
  });

  if (plan.op === 'aggregate') {
    const field = plan.group ? customFieldFor(info, plan.group.by) : undefined;
    if (!plan.group) push('unsupported_option', 'group', `${info.name} can only be counted by a dropdown or yes/no field.`);
    else if (!field || !field.groupable) push('unsupported_option', 'group.by', `${info.name} can't be counted by "${plan.group.by}"; only by a dropdown or yes/no field.`);
    else if (plan.group.bucket !== undefined) push('unsupported_option', 'group.bucket', `Only dates can be counted per ${plan.group.bucket}.`);
    const metrics = plan.metrics ?? [{ fn: 'count' as const }];
    if (metrics.length !== 1 || !('fn' in metrics[0]) || metrics[0].fn !== 'count') {
      push('unsupported_option', 'metrics', `Only counts of ${info.name} are supported.`);
    }
    for (const key of AGGREGATE_EXCLUDED_KEYS) {
      if (plan[key] !== undefined) push('unsupported_option', key, `${key} can't be used with a count breakdown.`);
    }
  } else if (plan.op === 'list' || plan.op === 'count') {
    if (plan.group !== undefined) push('unsupported_option', 'group', 'Counting by a field needs op "aggregate".');
    if (plan.metrics !== undefined) push('unsupported_option', 'metrics', 'Metrics need op "aggregate".');
    if (plan.top !== undefined) {
      if (plan.op !== 'list') push('unsupported_option', 'top', 'top N is only for lists.');
      else if (plan.top > MAX_LIST_LIMIT) push('unsupported_option', 'top', `At most the top ${MAX_LIST_LIMIT} can be listed.`);
    }
    if (plan.sort) {
      const field = customFieldFor(info, plan.sort.by);
      if (!field || !field.sortable) push('unsupported_option', 'sort.by', `${info.name} can't be sorted by "${plan.sort.by}".`);
    }
  }
  if (problems.length) return { ok: false, problems };

  // top N is the page size of a list (never more than N per page).
  const topSize = plan.top !== undefined ? Math.min(plan.top, plan.pageSize ?? plan.top) : undefined;
  const checked: QueryPlan = {
    ...plan,
    ...(plan.where !== undefined ? { where } : {}),
    ...(topSize !== undefined && topSize !== plan.pageSize ? { pageSize: topSize } : {}),
  };
  return { ok: true, plan: checked, info };
}

/* ── Executors ─────────────────────────────────────────────────────────── */

function reject(path: string, message: string): PlanRejectedError {
  return new PlanRejectedError([problem('unsupported_option', path, message)]);
}

/** What no executor M read may skip: the module, and no plan key that would change which records are read. */
function refuseUnrunnable(info: CustomModuleInfo, plan: QueryPlan): void {
  if (!('module' in plan.target) || plan.target.module !== info.key) {
    throw new PlanRejectedError([problem('unknown_module', 'target.module', `Not a plan for ${info.name}.`)]);
  }
  for (const [key, what] of UNSUPPORTED_KEYS) if (plan[key] !== undefined) throw reject(key, `${info.name} ${what}.`);
}

/** where, then search: every list, count and breakdown member after the base. */
function conditionsOf(info: CustomModuleInfo, plan: QueryPlan, ctx: CustomExecContext): Fragment[] {
  refuseUnrunnable(info, plan);
  const env: CompileEnv = { timezone: isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC', now: ctx.now ?? new Date() };
  const compiled = compileCustomWhere(info, plan.where, env);
  if (compiled.problems.length) throw new PlanRejectedError(compiled.problems);
  const search = compileCustomSearch(info, plan.search);
  return [...compiled.fragments, ...(search ? [search] : [])];
}

function finiteCount(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** For a read that found no records: whether the module itself is gone
 * (deleted since its definition was cached; one read by tenant and slug, and
 * the registry then drops the tenant's cached definitions). */
async function moduleGone(info: CustomModuleInfo, ctx: CustomExecContext): Promise<boolean> {
  return !(await customModuleStillDefined(ctx.tenantId, info));
}

/** The fields a row carries: the table's columns and the fields that name a record. */
function shownFields(info: CustomModuleInfo): CustomFieldInfo[] {
  return [...new Set([...info.columns, ...info.titleFields])];
}

function rowOf(info: CustomModuleInfo, raw: Record<string, unknown>): CustomRecordRow {
  const stored = isRecord(raw.data) ? raw.data : {};
  const data: Record<string, unknown> = {};
  for (const field of shownFields(info)) {
    if (Object.prototype.hasOwnProperty.call(stored, field.fieldKey)) data[field.fieldKey] = stored[field.fieldKey];
  }
  const id = raw._id === null || raw._id === undefined ? '' : String(raw._id);
  const created = raw.createdAt instanceof Date ? raw.createdAt
    : typeof raw.createdAt === 'string' || typeof raw.createdAt === 'number' ? new Date(raw.createdAt) : null;
  return {
    id: OBJECT_ID.test(id) ? id : null,
    recordId: typeof raw.recordId === 'string' && raw.recordId.trim() ? raw.recordId : null,
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    data,
  };
}

/** plan.sort (a field executor M can sort by), else newest first. */
function sortOf(info: CustomModuleInfo, plan: QueryPlan): { field: CustomFieldInfo; dir: 'asc' | 'desc' } {
  if (!plan.sort) return { field: info.created, dir: 'desc' };
  const field = customFieldFor(info, plan.sort.by);
  if (!field || !field.sortable) throw reject('sort.by', `${info.name} can't be sorted by "${plan.sort.by}".`);
  return { field, dir: plan.sort.dir };
}

/** A yes/no value read as the conditions read it (fragmentOf): true is yes;
 * false, '' (never touched), null and a missing key are no (false); a value of
 * another type is neither (null). $ifNull turns null and a missing key into ''. */
function yesNoExpression(value: string): Record<string, unknown> {
  return { $cond: [{ $eq: [value, true] }, true, { $cond: [{ $in: [{ $ifNull: [value, ''] }, [false, '']] }, false, null] }] };
}

/** What a page sorted by a record field is ordered by: the stored value when
 * it is of the field's own type (a number; a string, blank ones not; a
 * date string that starts with a day key; yes, or no as the form shows it),
 * else null, so values of another type or none sort with the missing ones
 * (first going up, last going down), as a sort by a typed field does. */
function sortKeyOf(field: CustomFieldInfo): Record<string, unknown> {
  const value = `$${field.path}`;
  const isString = { $eq: [{ $type: value }, 'string'] };
  switch (field.kind) {
    case 'number': return { $cond: [{ $isNumber: value }, value, null] };
    case 'boolean': return yesNoExpression(value);
    case 'date': case 'datetime':
      return { $cond: [isString, { $cond: [{ $regexMatch: { input: value, regex: '^\\d{4}-\\d{2}-\\d{2}' } }, value, null] }, null] };
    default: return { $cond: [{ $and: [isString, { $ne: [value, ''] }] }, value, null] };
  }
}

/** A page of records. Sort: plan.sort, else newest first; _id breaks ties. */
export async function executeCustomList(info: CustomModuleInfo, plan: QueryPlan, ctx: CustomExecContext): Promise<CustomListOutcome> {
  const conditions = conditionsOf(info, plan, ctx);
  const sort = sortOf(info, plan);
  const page = Math.max(1, Math.floor(plan.page ?? 1));
  const size = Math.min(Math.max(Math.floor(plan.pageSize ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  const dir: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
  const select: Record<string, 1> = { recordId: 1, createdAt: 1 };
  for (const field of shownFields(info)) select[field.path] = 1;
  const window = { skip: (page - 1) * size, limit: size, select };
  // The creation date is a stored Date on every record: a plain sort.
  const read = sort.field.system
    ? customFind(ctx.tenantId, info.slug, conditions, { sort: { [sort.field.path]: dir, _id: dir }, ...window })
    : customFindByKey(ctx.tenantId, info.slug, conditions, { key: sortKeyOf(sort.field), dir, ...window });
  const [rows, count] = await Promise.all([read, customCount(ctx.tenantId, info.slug, conditions)]);
  const items = rows.map((row) => rowOf(info, row));
  const result: CustomListOutcome = { items, total: finiteCount(count) ?? items.length, page, size, sort: { by: sort.field.key, dir: sort.dir } };
  return result.total === 0 && !items.length && await moduleGone(info, ctx) ? { ...result, moduleGone: true } : result;
}

/** How many records the same conditions match (null when the count isn't a number, never 0). */
export async function executeCustomCount(info: CustomModuleInfo, plan: QueryPlan, ctx: CustomExecContext): Promise<CustomCountOutcome> {
  const conditions = conditionsOf(info, plan, ctx);
  const total = finiteCount(await customCount(ctx.tenantId, info.slug, conditions));
  return total === 0 && await moduleGone(info, ctx) ? { total, moduleGone: true } : { total };
}

/** A dropdown's value, anything else (blank, missing, another type) "not set"
 * (null); or yes / no as the conditions read it, so the "No" row counts what
 * a "no" condition does (only a value of another type is "not set"). */
function groupExpression(field: CustomFieldInfo): Record<string, unknown> {
  const value = `$${field.path}`;
  if (field.kind === 'boolean') return yesNoExpression(value);
  return { $cond: [{ $and: [{ $eq: [{ $type: value }, 'string'] }, { $ne: [value, ''] }] }, value, null] };
}

function groupKey(value: unknown): string | null {
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Counts per value of a dropdown or yes/no field, most first, at most
 * MAX_QUERY_GROUPS; totalGroups and total count every group and record. */
export async function executeCustomGroups(info: CustomModuleInfo, plan: QueryPlan, ctx: CustomExecContext): Promise<CustomGroupsOutcome> {
  if (!plan.group) throw reject('group', `A breakdown of ${info.name} needs a field to count by.`);
  const field = customFieldFor(info, plan.group.by);
  if (!field || !field.groupable || plan.group.bucket !== undefined) {
    throw reject('group.by', `${info.name} can't be counted by "${plan.group.by}".`);
  }
  const conditions = conditionsOf(info, plan, ctx);
  const by = groupExpression(field);
  const [rows, totalGroups, count] = await Promise.all([
    customGroup(ctx.tenantId, info.slug, conditions, { by, limit: MAX_QUERY_GROUPS }),
    customGroupCount(ctx.tenantId, info.slug, conditions, by),
    customCount(ctx.tenantId, info.slug, conditions),
  ]);
  const groups = rows.map((row) => ({ key: groupKey(row._id), count: finiteCount(row.n) ?? 0 }));
  const result: CustomGroupsOutcome = {
    groups,
    totalGroups: Math.max(totalGroups, groups.length),
    total: finiteCount(count) ?? groups.reduce((sum, g) => sum + g.count, 0),
  };
  return result.total === 0 && await moduleGone(info, ctx) ? { ...result, moduleGone: true } : result;
}

/** The read a validated plan asks for: a list, a count, or a count breakdown. */
export async function executeCustomPlan(info: CustomModuleInfo, plan: QueryPlan, ctx: CustomExecContext): Promise<CustomOutcome> {
  if (plan.op === 'aggregate') return { op: 'aggregate', result: await executeCustomGroups(info, plan, ctx) };
  if (plan.op === 'count') return { op: 'count', ...(await executeCustomCount(info, plan, ctx)) };
  if (plan.op === 'list') return { op: 'list', result: await executeCustomList(info, plan, ctx) };
  throw new PlanRejectedError([problem('unsupported_op', 'op', `${info.name} have no record page to open here; ask for a list instead.`)]);
}

/* ── Table handles (POST /view) ────────────────────────────────────────── */

function withoutPage(plan: QueryPlan): QueryPlan {
  const { page: _page, ...rest } = plan;
  return rest;
}

/** A Custom Module table's handle plan with one view change applied, as the
 * view route does for executor L and Q tables: "w<i>" drops plan.where[i] and
 * "search" the search ("mine" and the engine's own chips never exist here); a
 * sort must be a field executor M can sort by; a new sort or a removed chip
 * starts again from the first page. The caller validates the result
 * (validateCustomPlan) and re-runs it on executor M as the current caller. */
export function applyCustomViewAction(info: CustomModuleInfo, handlePlan: QueryPlan, change: CustomViewChange): CustomViewChangeResult {
  if (!('module' in handlePlan.target) || handlePlan.target.module !== info.key || handlePlan.op !== 'list' || handlePlan.record !== undefined) {
    return { ok: false, code: 'not_rerunnable', message: "This table can't be changed here. Ask the assistant again instead." };
  }
  let plan: QueryPlan = { ...handlePlan };
  let reset = false;
  if (change.removeFilter !== undefined) {
    const id = change.removeFilter;
    const where = /^w(0|[1-9]\d{0,2})$/.exec(id);
    const index = where ? Number(where[1]) : -1;
    if (where && plan.where && index < plan.where.length) {
      const rest = plan.where.filter((_, i) => i !== index);
      const { where: _where, ...others } = plan;
      plan = rest.length ? { ...others, where: rest } : others;
    } else if (id === 'search' && plan.search !== undefined) {
      const { search: _search, ...others } = plan;
      plan = others;
    } else {
      return { ok: false, code: 'filter_not_removable', message: "That filter can't be removed from this table." };
    }
    reset = true;
  }
  if (change.sort !== undefined) {
    const field = customFieldFor(info, change.sort.key);
    if (!field || !field.sortable) return { ok: false, code: 'not_sortable', message: "This table can't be sorted by that column." };
    plan = { ...plan, sort: { by: field.key, dir: change.sort.dir } };
    reset = true;
  }
  if (change.page !== undefined) plan = { ...plan, page: change.page };
  else if (reset) plan = withoutPage(plan);
  return { ok: true, plan };
}
