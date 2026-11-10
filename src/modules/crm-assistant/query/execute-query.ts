import type { Cond, QueryPlan } from '../contracts/plan';
import { VIEW_CAPS } from '../contracts/views';
import type { SectionState } from '../contracts/views';
import type { FieldCap, ModuleCap } from '../registry/types';
import { isQueryGroupable, isQuerySortable, queryCapsFor } from '../registry/query-caps';
import type { PlanProblem } from './validate';
import {
  ExecContext, ListOutcome, ReadContext, StatusInfo, loadReadContext, loadStatusInfo, moduleDefFor, protectAndProject,
  recordCurrenciesRead, withRecordCurrencies,
} from './execute-list';
import {
  CompileEnv, ImpliedCondition, comparedMoneyFields, compileSearch, compileWhere, currencyRules, dateBucketExpression,
  dateRuleOf, fieldFor, resolveRelRange,
} from './compile';
import { companyCurrenciesFor, scopedCount, scopedFind, scopedGroup, scopedGroupCount } from './scoped-match';
import { mineCondition, minePartialText } from './mine';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { isValidTimeZone } from '../../native-crm/shared/date-range';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../internal/crm-gateway.helpers';
import { logger } from '../../../utils/logger';

/* Executor Q: one module's records read with a scoped query (scoped-match.ts)
 * instead of the module's own list(), for plans list() can't run: conditions
 * (states, stages, enum values, dates, amounts), every explicit sort (list()
 * sorts have no unique tie-breaker), top N, count breakdowns and "mine". A
 * list, its count and its breakdown are built from the same conditions (where,
 * then search, then "mine"), so a count always equals its list's total. Rows
 * get exactly executor L's post-processing (applyPIIProtection, the read
 * projection, READ_FORBIDDEN_KEYS) and the same ReadContext. A "mine" that
 * can't be answered for this caller throws MineUnavailableError
 * (query/mine.ts) to the caller, which says why instead of reading; one the
 * scope can leave some of the caller's own records out of carries a
 * mine_partial note (minePartialText).
 *
 * Increment 5: a list, count or breakdown may take QueryExtras, what a
 * relation adds (query/relations.ts): its keys as further $and members after
 * the plan's own conditions (never merged into the scope object), its notes
 * (shown before executor Q's own) and why the answer is partial. A count and
 * its list still share every member. A window on a date some records have
 * none of (a receipt's payment date) says how many it leaves out
 * (undatedNotices), and a list shows each Field Service amount in its own
 * record's company currency (execute-list.ts withRecordCurrencies). */

export interface QueryNotice { code: string; tone: 'info' | 'warning'; text: string }

/** Why an answer is partial (SectionState.partialReasons). */
export type PartialReason = NonNullable<SectionState['partialReasons']>[number];

/** What a relation adds to a read (query/relations.ts prepareRelation). */
export interface QueryExtras {
  /** Further $and members after the plan's own conditions; each stays its own member next to the closed scope object. */
  conditions: Record<string, unknown>[];
  /** Notes shown with the answer, before executor Q's own. */
  notices: QueryNotice[];
  /** Why the answer is partial (relation_key_cap, scope_limited). */
  partialReasons?: PartialReason[];
}

/** The plan can't run as asked; each problem names why (compile.ts). */
export class PlanRejectedError extends Error {
  constructor(readonly problems: PlanProblem[]) {
    super(`Plan rejected: ${[...new Set(problems.map((p) => p.code))].join(', ') || 'invalid_plan'}`);
    this.name = 'PlanRejectedError';
  }
}

export interface QueryListOutcome extends ListOutcome {
  sort: { by: string; dir: 'asc' | 'desc' };
  implied: ImpliedCondition[];
  notices: QueryNotice[];
  /** False only when the module has a Field Service amount ('fs_branch' money), no
   * branch is picked and the tenant's companies use more than one currency (or
   * those currencies can't be read): executor Q refuses to rank such amounts for
   * this caller, so their columns must not be offered for sorting. */
  fsRankable: boolean;
  /** Present only when the extras made the answer partial. */
  partialReasons?: PartialReason[];
}

export interface QueryCountOutcome {
  /** null when the count isn't a number, never 0. */
  total: number | null;
  implied: ImpliedCondition[];
  notices: QueryNotice[];
  /** Present only when the extras made the answer partial. */
  partialReasons?: PartialReason[];
}

export interface GroupRow { key: string | null; count: number }

export interface QueryGroupsOutcome {
  /** Most first for a field; for date buckets oldest first (the no-date bucket first), the ones nearest today (see bucketsKept). */
  groups: GroupRow[];
  /** Every group the conditions make, the no-date bucket included, however many come back. */
  totalGroups: number;
  total: number;
  read: ReadContext;
  implied: ImpliedCondition[];
  notices: QueryNotice[];
  /** Date buckets only, and only when some were left out: 'nearest' when there
   * were more than MAX_DATE_BUCKETS dated buckets and `groups` holds the
   * MAX_DATE_BUCKETS nearest today's bucket (without the no-date bucket), to be
   * shown as they are. Absent: every bucket came back. 'latest' and 'earliest'
   * (the newest or the oldest buckets) are what executor Q reported before; it
   * no longer does. */
  bucketsKept?: 'nearest' | 'latest' | 'earliest';
  /** Date buckets read with opts.maxDateBuckets only (a chart, Increment 8):
   * how many records have no date (the no-date bucket's count, 0 when there is
   * none), also when that bucket isn't in `groups` because dated ones were left out. */
  undatedGroup?: number;
  /** Present only when the extras made the answer partial. */
  partialReasons?: PartialReason[];
}

/** At most this many groups by a field come back (the composer shows at most 25 rows). */
export const MAX_QUERY_GROUPS = 50;

/** A date breakdown with more dated buckets than this keeps this many: the
 * ones nearest today's, as many as a table shows (25). */
export const MAX_DATE_BUCKETS = VIEW_CAPS.rows;

interface Prepared {
  /** where, the implied conditions, search, then "mine": every list, count and breakdown member after the scope. */
  conditions: Record<string, unknown>[];
  implied: ImpliedCondition[];
  status: StatusInfo | null;
  timezone: string;
  /** The clock the conditions were compiled with. */
  now: Date;
  /** For the other-currencies notice: the same conditions with the amounts left out, and another currency. */
  otherCurrency?: Record<string, unknown>[];
  /** "Mine" under a scope that can leave some of the caller's own records out (query/mine.ts minePartial). */
  minePartial?: QueryNotice;
  /** The extras' notes, shown first. */
  extraNotices?: QueryNotice[];
  /** The extras' reasons the answer is partial. */
  partialReasons?: PartialReason[];
  /** For the undated notice: a window on a date some records lack (FieldCap.undatedNotice). */
  undated?: UndatedCheck;
}

/** A date window on a field some records have no value in (FieldCap.undatedNotice:
 * a receipt's payment date): the field, and every member of the read except
 * that window, to count the records it leaves out for having no date. */
export interface UndatedCheck { field: FieldCap; conditions: Record<string, unknown>[] }

/** The operators that put a date in a window. */
const WINDOW_OPS: ReadonlySet<string> = new Set(['within', 'between', 'gt', 'gte', 'lt', 'lte']);

/** The where's window on a FieldCap.undatedNotice date, if it has one: that
 * field and the where without its windows. */
function undatedWindow(cap: ModuleCap, where: readonly Cond[] | undefined): { field: FieldCap; rest: Cond[] } | null {
  const windowOn = (cond: Cond): FieldCap | undefined => ('f' in cond && WINDOW_OPS.has(cond.op) ? fieldFor(cap, cond.f) : undefined);
  const field = (where ?? []).map(windowOn).find((f) => f?.undatedNotice);
  return field ? { field, rest: (where ?? []).filter((cond) => windowOn(cond) !== field) } : null;
}

function reject(cap: ModuleCap, path: string, message: string): PlanRejectedError {
  return new PlanRejectedError([{ code: 'unsupported_option', path, message: `${message}`.replace('{plural}', cap.labels.plural) }]);
}

/** The caller's FS currency (getSettings, which falls back to its own default
 * when nothing is saved); null when the settings can't be read. */
async function fsCurrency(ctx: ExecContext): Promise<string | null> {
  try {
    const settings = await getSettings(ctx.tenantId, ctx.branchId ?? null) as { currency?: unknown } | null;
    const currency = typeof settings?.currency === 'string' ? settings.currency.trim() : '';
    return currency || 'INR';
  } catch {
    return null;
  }
}

/** The money field a list is ranked by, if any (ranking is a comparison too). */
function rankedMoneyField(cap: ModuleCap, plan: QueryPlan): FieldCap | undefined {
  const field = plan.sort ? fieldFor(cap, plan.sort.by) : undefined;
  return field?.kind === 'money' ? field : undefined;
}

/** `undatedCheck`: also prepare the undated notice's members (UndatedCheck) when the plan has such a window. */
async function prepare(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, withStatus: boolean, undatedCheck = true): Promise<Prepared> {
  const qc = queryCapsFor(cap.key);
  if (!qc?.q) throw reject(cap, 'executor', '{plural} can only be listed and counted as they are.');
  const timezone = isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC';
  const compared = comparedMoneyFields(cap, plan.where);
  const ranked = rankedMoneyField(cap, plan);
  const ownCurrency = [...compared, ...(ranked ? [ranked] : [])].some((f) => typeof f.money?.currency === 'object');
  // "mine" is decided from the caller's identity (query/mine.ts); a MineUnavailableError goes to the caller.
  const [status, currency, mine] = await Promise.all([
    withStatus ? loadStatusInfo(cap, ctx.tenantId) : Promise.resolve(null),
    ownCurrency ? fsCurrency(ctx) : Promise.resolve(null),
    plan.mine ? mineCondition(cap, plan.mine, ctx) : Promise.resolve(null),
  ]);
  const env: CompileEnv = { tenantId: ctx.tenantId, timezone, now: ctx.now ?? new Date(), branchId: ctx.branchId, status, currency };

  const compiled = await compileWhere(cap, plan.where, env);
  const problems = [...compiled.problems];
  const fragments = [...compiled.fragments];
  const implied = [...compiled.implied];
  // What ranking an amount adds (the caller's currency next to a deal amount).
  const rankedFragments: Record<string, unknown>[] = [];
  if (ranked && !compared.includes(ranked)) {
    const rules = await currencyRules(cap, [ranked], plan.where, env);
    problems.push(...rules.problems);
    rules.implied.forEach((cond, i) => {
      if (implied.some((known) => known.id === cond.id)) return;
      implied.push(cond);
      rankedFragments.push(rules.fragments[i]);
    });
  }
  if (problems.length) throw new PlanRejectedError(problems);

  const search = compileSearch(cap, plan.search);
  // "mine" is the last member, its own $and member like every other condition:
  // it only narrows what the scope already lets the caller see.
  const own = mine ? [mine.condition] : [];
  const conditions = [...fragments, ...rankedFragments, ...(search ? [search] : []), ...own];

  // A window on a date some records have none of: the same members without
  // that window, for the count of what it leaves out (undatedNotices).
  let undated: UndatedCheck | undefined;
  const window = undatedCheck ? undatedWindow(cap, plan.where) : null;
  if (window) {
    const rest = await compileWhere(cap, window.rest, env);
    if (!rest.problems.length) undated = { field: window.field, conditions: [...rest.fragments, ...rankedFragments, ...(search ? [search] : []), ...own] };
  }

  let otherCurrency: Record<string, unknown>[] | undefined;
  const cur = implied.find((cond) => cond.reason === 'currency');
  if (cur) {
    // Records in other currencies: the same scope and conditions, without the
    // amount comparisons (their amounts were not compared), and not the caller's currency.
    const unranked = (plan.where ?? []).filter((cond) => !('f' in cond) || !compared.some((f) => f.key === cond.f));
    const [rest, pinned] = await Promise.all([compileWhere(cap, unranked, env), compileWhere(cap, [cur.cond], env)]);
    if (!rest.problems.length && !pinned.problems.length && pinned.fragments.length) {
      otherCurrency = [...rest.fragments, ...(search ? [search] : []), { $nor: [pinned.fragments[0]] }, ...own];
    }
  }
  // A fixed note, never a count of what the scope hides (that would read outside it).
  const partial = plan.mine ? minePartialText(cap, plan.mine, ctx.scope.kind) : null;
  return {
    conditions, implied, status, timezone, now: env.now,
    ...(otherCurrency ? { otherCurrency } : {}),
    ...(partial ? { minePartial: { code: 'mine_partial', tone: 'info' as const, text: partial } } : {}),
    ...(undated ? { undated } : {}),
  };
}

/** The prepared plan with a relation's extras: their conditions after the
 * plan's own, each its own member (the other-currencies and undated counts get
 * them too, so they stay inside the relation), their notes and partial reasons. */
function withExtras(prepared: Prepared, extras: QueryExtras | undefined): Prepared {
  if (!extras) return prepared;
  const more = [...(extras.conditions ?? [])];
  if (more.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) throw new Error('A relation condition must be an object.');
  const reasons = [...new Set(extras.partialReasons ?? [])];
  return {
    ...prepared,
    conditions: [...prepared.conditions, ...more],
    ...(prepared.otherCurrency ? { otherCurrency: [...prepared.otherCurrency, ...more] } : {}),
    ...(prepared.undated ? { undated: { ...prepared.undated, conditions: [...prepared.undated.conditions, ...more] } } : {}),
    ...(extras.notices?.length ? { extraNotices: [...extras.notices] } : {}),
    ...(reasons.length ? { partialReasons: reasons } : {}),
  };
}

/** An outcome's partialReasons: present only when there are some. */
function partialOf(prepared: Prepared): { partialReasons?: PartialReason[] } {
  return prepared.partialReasons?.length ? { partialReasons: [...prepared.partialReasons] } : {};
}

/** Every member executor Q's list, count and breakdown put after the scope
 * (where, search, "mine", then the extras), the conditions the engine added,
 * executor Q's notes and the stage labels: for a read that runs its own
 * aggregation over exactly those members (query/metrics.ts). A window on a
 * date some records lack is not counted here: `undated` comes back for the
 * caller to count with its own members (undatedNotices). Throws
 * PlanRejectedError and MineUnavailableError as the executors do. */
export async function prepareQuery(
  cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras,
): Promise<{
  conditions: Record<string, unknown>[]; implied: ImpliedCondition[]; notices: QueryNotice[]; status: StatusInfo | null;
  partialReasons?: PartialReason[]; undated?: UndatedCheck;
}> {
  const prepared = withExtras(await prepare(cap, plan, ctx, true), extras);
  const notices = await noticesFor(cap, ctx, { ...prepared, undated: undefined });
  return {
    conditions: prepared.conditions, implied: prepared.implied, notices, status: prepared.status, ...partialOf(prepared),
    ...(prepared.undated ? { undated: prepared.undated } : {}),
  };
}

/** Only the members a plan's where, search and "mine" compile to, with the
 * conditions the engine added (a deal amount's currency); nothing is read
 * but what compiling needs (stage keys, the caller's currency): the related
 * side of a relation (query/relations.ts). Throws PlanRejectedError. */
export async function compileQueryConditions(
  cap: ModuleCap, plan: QueryPlan, ctx: ExecContext,
): Promise<{ conditions: Record<string, unknown>[]; implied: ImpliedCondition[] }> {
  const prepared = await prepare(cap, plan, ctx, false, false);
  return { conditions: prepared.conditions, implied: prepared.implied };
}

/** Whether this caller can rank the module's Field Service amounts ('fs_branch'
 * money), by the rule currencyRules applies: always when the module has none or
 * a branch is picked; otherwise only when the tenant's companies all use one
 * currency (the request's one read of them, scoped-match.ts
 * companyCurrenciesFor). False when those currencies can't be read (ranking
 * would fail too). */
export async function fsAmountsRankable(cap: ModuleCap, ctx: Pick<ExecContext, 'tenantId' | 'branchId'>): Promise<boolean> {
  if (!cap.fields.some((f) => f.kind === 'money' && f.money?.currency === 'fs_branch')) return true;
  if (ctx.branchId) return true;
  try {
    return (await companyCurrenciesFor(ctx)).all.length <= 1;
  } catch (err) {
    logger.warn('CRM assist: tenant currencies unavailable', { module: cap.key, error: (err as Error)?.message });
    return false;
  }
}

/** How long a list waits for fsAmountsRankable. The answer only decides whether
 * a money column is offered for sorting, so a slow or failed settings read
 * hides that sort instead of holding up (or, at the resolve deadline, dropping)
 * a table whose rows are ready. Same budget as the composer's FS_RANKABLE_BUDGET. */
export const FS_RANKABLE_BUDGET_MS = 400;

async function fsAmountsRankableWithin(cap: ModuleCap, ctx: Pick<ExecContext, 'tenantId' | 'branchId'>, budgetMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, budgetMs)); });
  try {
    return await Promise.race([fsAmountsRankable(cap, ctx).catch(() => false), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The notes of a read: the extras' (a relation's) first, then executor Q's
 * own, a partial "mine", amounts in other currencies and then records a date
 * window leaves out for having no date. */
async function noticesFor(cap: ModuleCap, ctx: ExecContext, prepared: Prepared): Promise<QueryNotice[]> {
  const [other, undated] = await Promise.all([
    otherCurrencyNotices(cap, ctx, prepared),
    prepared.undated ? undatedNotices(cap, ctx, prepared.undated) : Promise.resolve([]),
  ]);
  return [
    ...(prepared.extraNotices ?? []),
    ...(prepared.minePartial ? [prepared.minePartial] : []),
    ...other,
    ...undated,
  ];
}

/** How many records a date window leaves out because they have no date at
 * all (a receipt saved without a payment date: no window can include it), as
 * a note; none when there are none. `check`: the read's members without that
 * window (UndatedCheck); `members`: what else counts (a named total's own,
 * query/metrics.ts); `what`: the records in words ("completed receipts"). A
 * count that fails gives the fixed note instead, never a number. */
export async function undatedNotices(
  cap: ModuleCap, ctx: ExecContext, check: UndatedCheck,
  opts: { members?: Record<string, unknown>[]; what?: { one: string; many: string } } = {},
): Promise<QueryNotice[]> {
  const what = opts.what ?? { one: cap.labels.singular.toLowerCase(), many: cap.labels.plural.toLowerCase() };
  const date = check.field.label.toLowerCase();
  try {
    const n = await scopedCount(cap, ctx, [...check.conditions, ...(opts.members ?? []), { [check.field.path]: { $not: { $type: 'date' } } }]);
    if (!(typeof n === 'number' && n > 0)) return [];
    const text = n === 1
      ? `1 ${what.one} has no ${date}, so no date window includes it.`
      : `${n} ${what.many} have no ${date}, so no date window includes them.`;
    return [{ code: 'undated_left_out', tone: 'info', text }];
  } catch (err) {
    logger.warn('CRM assist: undated count failed', { module: cap.key, error: (err as Error)?.message });
    return [{ code: 'undated_left_out', tone: 'info', text: `${sentenceCase(what.many)} with no ${date} are in no date window.` }];
  }
}

function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

async function otherCurrencyNotices(cap: ModuleCap, ctx: ExecContext, prepared: Prepared): Promise<QueryNotice[]> {
  if (!prepared.otherCurrency) return [];
  try {
    const n = await scopedCount(cap, ctx, prepared.otherCurrency);
    if (!(typeof n === 'number' && n > 0)) return [];
    const text = n === 1
      ? `1 ${cap.labels.singular.toLowerCase()} in another currency was not compared.`
      : `${n} ${cap.labels.plural.toLowerCase()} in other currencies were not compared.`;
    return [{ code: 'other_currencies', tone: 'info', text }];
  } catch (err) {
    logger.warn('CRM assist: other-currency count failed', { module: cap.key, error: (err as Error)?.message });
    return [{ code: 'other_currencies', tone: 'info', text: `${cap.labels.plural} in other currencies were not compared.` }];
  }
}

/** plan.sort (a field executor Q can sort by), else the module's default sort. */
function sortOf(cap: ModuleCap, plan: QueryPlan): { by: string; dir: 'asc' | 'desc'; path: string } {
  if (plan.sort) {
    const field = fieldFor(cap, plan.sort.by);
    if (!field || !isQuerySortable(cap, field)) throw reject(cap, 'sort.by', `{plural} can't be sorted by "${plan.sort.by}".`);
    return { by: field.key, dir: plan.sort.dir, path: field.path };
  }
  const { by, dir } = cap.sort.default;
  return { by, dir, path: fieldFor(cap, by)?.path ?? by };
}

function finiteCount(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A page of records. Sort: plan.sort else the module's default, with _id as
 * tie-breaker. Field Service amounts are labelled with each record's own
 * company currency (execute-list.ts withRecordCurrencies), from the same read
 * of the tenant's currencies fsRankable uses. `extras`: a relation's (QueryExtras). */
export async function executeQueryList(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras): Promise<QueryListOutcome> {
  const def = moduleDefFor(cap);
  const prepared = withExtras(await prepare(cap, plan, ctx, true), extras);
  const sort = sortOf(cap, plan);
  const page = Math.max(1, Math.floor(plan.page ?? 1));
  const size = Math.min(Math.max(Math.floor(plan.pageSize ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  const dir: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
  const mongoSort: Record<string, 1 | -1> = sort.path === '_id' ? { _id: dir } : { [sort.path]: dir, _id: dir };

  const [rows, count, read, notices, fsRankable, currencies] = await Promise.all([
    scopedFind(cap, ctx, prepared.conditions, { sort: mongoSort, skip: (page - 1) * size, limit: size }),
    scopedCount(cap, ctx, prepared.conditions),
    loadReadContext(cap, def, ctx, prepared.status),
    noticesFor(cap, ctx, prepared),
    fsAmountsRankableWithin(cap, ctx, FS_RANKABLE_BUDGET_MS),
    recordCurrenciesRead(cap, ctx),
  ]);
  const items = await protectAndProject(def, rows, ctx);
  return {
    items, total: finiteCount(count) ?? items.length, page, size, read: withRecordCurrencies(read, rows, currencies),
    sort: { by: sort.by, dir: sort.dir }, implied: prepared.implied, notices, fsRankable, ...partialOf(prepared),
  };
}

/** How many records the same conditions match (null when the count isn't a
 * number, never 0). `extras`: a relation's (QueryExtras). */
export async function executeQueryCount(
  cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras,
): Promise<QueryCountOutcome> {
  const prepared = withExtras(await prepare(cap, plan, ctx, false), extras);
  const [count, notices] = await Promise.all([scopedCount(cap, ctx, prepared.conditions), noticesFor(cap, ctx, prepared)]);
  return { total: finiteCount(count), implied: prepared.implied, notices, ...partialOf(prepared) };
}

function groupKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

/** How many buckets a date bucket (at `keyPath`, '$_id' by default: the first
 * day of its bucket) is from the one holding `today` (a day key), either way:
 * $dateDiff counts the bucket boundaries between the two days (weeks from
 * Monday, as dateBucketExpression truncates them), so a month away is 1
 * whatever its number of days. Null for the no-date bucket. query/metrics.ts
 * uses it on its grouped rows ('$_id.k'). */
export function bucketDistance(
  bucket: 'day' | 'week' | 'month' | 'quarter' | 'year', today: string, keyPath = '$_id',
): Record<string, unknown> {
  return {
    $abs: {
      $dateDiff: {
        startDate: new Date(`${today}T00:00:00Z`),
        endDate: { $dateFromString: { dateString: keyPath, format: '%Y-%m-%d', timezone: 'UTC' } },
        unit: bucket, timezone: 'UTC', ...(bucket === 'week' ? { startOfWeek: 'monday' } : {}),
      },
    },
  };
}

/** Counts per value of a groupable field, or per day / week (Monday) / month /
 * quarter / year of a date field in the tenant's timezone. A field's groups
 * come most first, at most MAX_QUERY_GROUPS. Date buckets come oldest first,
 * the no-date bucket first: all of them, up to MAX_DATE_BUCKETS dated ones;
 * past that, only the MAX_DATE_BUCKETS dated buckets nearest today's (counted
 * in buckets, a tie going to the earlier one), without the no-date bucket
 * (bucketsKept 'nearest'): the most recent for dates in the past, the soonest
 * for dates ahead, the ones around today for both. totalGroups and total
 * always count every group and every record. `extras`: a relation's (QueryExtras).
 * `opts.maxDateBuckets`: keep this many dated buckets instead of
 * MAX_DATE_BUCKETS (a chart keeps up to 50, Increment 8), and say how many
 * records have no date (undatedGroup) whether or not the no-date bucket is kept. */
export async function executeQueryGroups(
  cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras, opts: { maxDateBuckets?: number } = {},
): Promise<QueryGroupsOutcome> {
  const def = moduleDefFor(cap);
  const group = plan.group;
  if (!group) throw reject(cap, 'group', 'A breakdown of {plural} needs a field to count by.');
  const field = fieldFor(cap, group.by);
  if (!field || !isQueryGroupable(cap, field)) throw reject(cap, 'group.by', `{plural} can't be counted by "${group.by}".`);
  const isDate = field.kind === 'date' || field.kind === 'datetime';
  if (isDate && !group.bucket) throw reject(cap, 'group.bucket', `Counting {plural} by ${field.label.toLowerCase()} needs a day, week, month, quarter or year.`);
  if (!isDate && group.bucket) throw reject(cap, 'group.bucket', `Only dates can be counted per ${group.bucket}.`);

  const maxDated = opts.maxDateBuckets ?? MAX_DATE_BUCKETS;
  const prepared = withExtras(await prepare(cap, plan, ctx, true), extras);
  const by = isDate ? dateBucketExpression(field.path, dateRuleOf(field), prepared.timezone, group.bucket!) : `$${field.path}`;
  // Date buckets come nearest today's first (the no-date bucket, whose distance
  // is null, before them all), two rows more than are kept: room for the
  // no-date bucket, and one that tells whether any dated bucket was left out.
  const distance = isDate ? { d: bucketDistance(group.bucket!, resolveRelRange('today', prepared.timezone, prepared.now).fromKey) } : undefined;
  const sort: Record<string, 1 | -1> = isDate ? { d: 1, _id: 1 } : { n: -1, _id: 1 };
  const limit = isDate ? maxDated + 2 : MAX_QUERY_GROUPS;
  const [rows, totalGroups, count, read, notices] = await Promise.all([
    scopedGroup(cap, ctx, prepared.conditions, { by, addFields: distance, sort, limit }),
    scopedGroupCount(cap, ctx, prepared.conditions, by),
    scopedCount(cap, ctx, prepared.conditions),
    loadReadContext(cap, def, ctx, prepared.status),
    noticesFor(cap, ctx, prepared),
  ]);
  const dated = isDate ? rows.filter((row) => groupKey(row._id) !== null) : [];
  const trimmed = dated.length > maxDated;
  const kept = trimmed ? dated.slice(0, maxDated) : rows;
  const groups = kept.map((row) => ({ key: groupKey(row._id), count: finiteCount(row.n) ?? 0 }));
  // Date buckets oldest first (their keys are YYYY-MM-DD), the no-date bucket before them.
  const byDate = (a: GroupRow, b: GroupRow): number => (a.key === b.key ? 0 : a.key === null ? -1 : b.key === null ? 1 : a.key < b.key ? -1 : 1);
  if (isDate) groups.sort(byDate);
  const total = finiteCount(count) ?? groups.reduce((sum, g) => sum + g.count, 0);
  // The no-date bucket sorts first (its distance is null), so it is always among the rows read.
  const undated = isDate && opts.maxDateBuckets !== undefined
    ? { undatedGroup: finiteCount(rows.find((row) => groupKey(row._id) === null)?.n) ?? 0 } : {};
  return {
    groups, totalGroups: Math.max(totalGroups, groups.length), total, read, implied: prepared.implied, notices,
    ...(trimmed ? { bucketsKept: 'nearest' as const } : {}), ...undated, ...partialOf(prepared),
  };
}
