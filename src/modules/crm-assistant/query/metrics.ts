import type { Cond, QueryPlan } from '../contracts/plan';
import type { ModuleCap } from '../registry/types';
import { MetricDef, metricFor } from '../registry/metrics';
import type { ExecContext, ReadContext, StatusInfo } from './execute-list';
import { loadReadContext, moduleDefFor } from './execute-list';
import type { ImpliedCondition } from './compile';
import { dateBucketExpression, dateRuleOf, fieldFor, resolveRelRange, stageSpecFor } from './compile';
import {
  MAX_DATE_BUCKETS, MAX_QUERY_GROUPS, PartialReason, PlanRejectedError, QueryExtras, QueryNotice, bucketDistance, compileQueryConditions,
  prepareQuery, undatedNotices,
} from './execute-query';
import type { Bucket } from './aggregate';
import type { CompanyCurrencies } from './scoped-match';
import { companyCurrenciesFor, currencyExpressionOf, scopedAggregate, scopedCount } from './scoped-match';
import { loadStageInfo } from '../../daily-events/daily-events.query';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { isValidTimeZone } from '../../native-crm/shared/date-range';
import { logger } from '../../../utils/logger';

export { labelsFor } from './resolve-entity';

/* The named totals (registry/metrics.ts; plan 4.6, decision D5, Increment
 * 5): "purchase amount per customer", "outstanding", "payments received this
 * month". One aggregation over the target module's scoped filter
 * (scoped-match.ts scopedAggregate): the plan's own members (where, search,
 * "mine", a relation's extras), then the metric's (which records count:
 * not cancelled, unpaid, completed), grouped by each record's company
 * currency (currencyExpressionOf: Field Service documents carry none of
 * their own) and, with a breakdown, by the group field too. Amounts of
 * different currencies are never added together, nor ranked against each
 * other: every row is one key and one currency, and a breakdown's top N is
 * taken in each currency on its own (one $facet pipeline per currency). Stage
 * keys come from peekStages / loadStageInfo, which never write. Group keys are
 * stored values (customer numbers); naming them is the composer's job, through
 * labelsFor under the customer module's own gates.
 *
 * The list behind a total (its drill) carries the metric's own members as plan
 * conditions, so it lists exactly the records the total adds up; with rows in
 * more than one currency there is none (a list can't be cut by currency). A
 * plan that asks only for records the metric leaves out ("purchase amount of
 * cancelled invoices") gets a note saying so and no drill, and a window on a
 * date some records lack (a receipt's payment date) says how many it leaves
 * out (execute-query.ts undatedNotices).
 *
 * Increment 8: the deal totals (pipeline value: open deals; won value: deals
 * in a stage tagged won) are in each deal's own currency, trimmed and
 * upper-cased, a blank one in its company's; those currencies are known only
 * after the read, so the rows are ranked and cut per currency inside one
 * pipeline ($group per currency with $push and $slice) instead of a $facet per
 * known currency. A total may be broken down by its own date (bucketField) per
 * day, week, month, quarter or year, keeping the buckets nearest today's in
 * each currency, with each currency's first and last dated bucket (a chart's
 * range) and the clock the read used. Records in a stage no longer in the
 * pipeline (removed, or switched off in Pipeline & Stages settings) are counted
 * (they are neither cancelled nor final) and a parallel count says how many. */

/** Rows of a breakdown, unless the plan asks for another top N. */
export const DEFAULT_METRIC_TOP = 10;
/** At most this many rows of a breakdown. */
export const MAX_METRIC_TOP = MAX_QUERY_GROUPS;

/** contracts/plan.ts: a plan holds at most 10 conditions, an in / nin condition at most 50 values. */
const MAX_PLAN_CONDITIONS = 10;
const MAX_CONDITION_VALUES = 50;
/** A total in each record's own currency reads at most this many currencies. */
const MAX_RECORD_CURRENCIES = 20;
/** The operators that put a date in a window (as execute-query.ts reads them). */
const WINDOW_OPS: ReadonlySet<string> = new Set(['within', 'between', 'gt', 'gte', 'lt', 'lte']);

export interface MetricRow {
  /** The group value (a customer number, a stage key, a date bucket's first
   * day); null for records without one, and for a total with no breakdown. */
  key: string | null;
  /** The currency of these records (their company's, or a deal's own); null when it isn't known. */
  currency: string | null;
  /** The total, rounded to 2 decimals; null when it couldn't be read (never shown as 0). */
  value: number | null;
  /** How many records it adds up. */
  count: number;
}

export interface MetricOutcome {
  metric: MetricDef;
  /** One row per currency, or per group value and currency: the currencies in
   * groupsByCurrency's order, each largest first (and at most `top` of each).
   * By date: each currency's no-date row (key null) first, then its dated
   * buckets oldest first, at most `top` of them, the ones nearest today's. */
  rows: MetricRow[];
  /** Every (group value, currency) row the conditions make, however many came back. */
  totalGroups: number;
  /** The currencies the rows are in, in the order they are shown (the
   * caller's first, then A to Z), each with how many rows the conditions make
   * in it ("Top 10 of N" in each currency). A currency with none is left out.
   * By date, `span`: its first and last dated bucket, however many were kept
   * (absent when it has none). */
  groupsByCurrency: Array<{ currency: string | null; groups: number; span?: { lo: string; hi: string } }>;
  /** The most rows asked for in each currency (plan.top, default DEFAULT_METRIC_TOP; without a breakdown, MAX_METRIC_TOP;
   * by date, the dated buckets kept: opts.maxBuckets, default MAX_DATE_BUCKETS). */
  top: number;
  read: ReadContext;
  implied: ImpliedCondition[];
  notices: QueryNotice[];
  partialReasons?: PartialReason[];
  /** The metric's definition, shown with the answer. */
  basis: string;
  /** The list behind the total: the target's records under the plan's
   * conditions plus the metric's own (metricDrillPlan), so the list's total is
   * the total's record count. Absent when the rows are in more than one
   * currency, when the plan asks only for records the metric leaves out, or
   * when the conditions wouldn't fit one plan. */
  drill?: QueryPlan;
  /** The clock the read ran on (executeQueryMetric always sets it): the
   * tenant's timezone (UTC when it isn't valid), the instant, and today's day
   * key there, the one the buckets nearest today were picked from. A chart's
   * window and zero fill use it, never the wall clock. */
  clock?: { timezone: string; now: Date; todayKey: string };
  /** By date: the bucket (group.bucket). */
  bucket?: Bucket;
}

function reject(path: string, message: string): PlanRejectedError {
  return new PlanRejectedError([{ code: 'unsupported_option', path, message }]);
}

function pathOf(cap: ModuleCap, key: string): string {
  return fieldFor(cap, key)?.path ?? key;
}

/** The plan's one named metric of this module. */
function namedMetricOf(cap: ModuleCap, plan: QueryPlan): MetricDef {
  const metrics = plan.metrics ?? [];
  const first = metrics[0];
  if (metrics.length !== 1 || !first || !('metric' in first)) throw reject('metrics', 'A total needs exactly one named metric.');
  const metric = metricFor(cap.key, first.metric);
  if (!metric) throw reject('metrics.0.metric', `${cap.labels.plural} have no "${first.metric.slice(0, 60)}" total.`);
  return metric;
}

/** Which records a metric counts, from one set of stage facts: as the
 * aggregation's members, and as plan conditions for the list behind it
 * (drillWhere; null when they can't be written as plan conditions: more stage
 * keys than one condition holds, or a stage field the registry doesn't name).
 * `excluded`: the stage keys it leaves out (cancelled; for outstanding also the
 * final stages tagged paid; for pipeline value every final stage). */
interface Membership {
  members: Record<string, unknown>[];
  drillWhere: Cond[] | null;
  excluded: ReadonlySet<string>;
  /** The active stage keys of the module's pipeline (peekStages, isActive not
   * false), for the count of records in stages no longer in it (removed, or
   * switched off: the Deals screen leaves those out); absent when the metric
   * isn't counted that way (equals, outcome, a schema enum). */
  pipelineKeys?: ReadonlySet<string>;
  /** 'outcome': no stage is tagged with it, so nothing is added up. */
  noOutcome?: true;
}

async function membershipOf(metric: MetricDef, cap: ModuleCap, tenantId: string): Promise<Membership> {
  const include = metric.include;
  if (include.kind === 'equals') {
    return {
      members: [{ [pathOf(cap, include.field)]: include.value }],
      drillWhere: [{ f: include.field, op: 'eq', v: include.value }],
      excluded: new Set(),
    };
  }
  const spec = stageSpecFor(cap);
  if (!spec) {
    const which = include.kind === 'open' ? 'open' : include.kind === 'outcome' ? include.outcome : 'cancelled';
    throw reject('metrics', `${cap.labels.plural} have no stage, so ${which} ones can't be told apart.`);
  }
  if (include.kind === 'outcome') {
    // The stages tagged with the outcome, inactive ones included, as compile.ts
    // outcomeCondition reads them; none tagged matches nothing ($in: []).
    const keys = new Set<string>();
    if ('pipeline' in spec) {
      for (const s of (await peekStages(tenantId, spec.pipeline)) ?? []) {
        if (typeof s.outcome === 'string' && s.outcome.toLowerCase() === include.outcome) keys.add(s.key);
      }
    }
    return {
      members: [{ [spec.field]: { $in: [...keys] } }],
      drillWhere: keys.size ? [{ op: 'outcome', v: include.outcome }] : null,
      excluded: new Set(),
      ...(keys.size ? {} : { noOutcome: true as const }),
    };
  }
  const [info, stages] = await Promise.all([
    loadStageInfo(tenantId, spec, new Map()),
    'pipeline' in spec ? peekStages(tenantId, spec.pipeline).then((list) => list ?? []) : Promise.resolve(null),
  ]);
  // The stages still in the pipeline: a record on any other key (removed, or on a
  // stage switched off) is counted, and named in the note (removedStagesNotices).
  const pipelineKeys = stages
    ? new Set(stages.filter((s) => s && typeof s.key === 'string' && s.isActive !== false).map((s) => s.key))
    : undefined;
  if (include.kind === 'open') {
    // Not final: the same set as the 'open' state (compile.ts openFragment).
    const terminal = new Set(info.terminal);
    return {
      members: terminal.size ? [{ [spec.field]: { $nin: [...terminal] } }] : [],
      drillWhere: [{ op: 'state', v: 'open' }],
      excluded: terminal,
      ...(pipelineKeys ? { pipelineKeys } : {}),
    };
  }
  // loadStageInfo's cancelled set: final stages tagged cancelled or lost, or keyed cancel, lost, reject or disqualif.
  const excluded = new Set(info.cancelled);
  const members: Record<string, unknown>[] = [];
  const drillWhere: Cond[] = [];
  if (include.kind === 'unpaid') {
    members.push({ [pathOf(cap, include.paidFlag)]: { $ne: true } });
    drillWhere.push({ f: include.paidFlag, op: 'ne', v: true });
    for (const s of stages ?? []) {
      if (s.isTerminal && typeof s.outcome === 'string' && s.outcome.toLowerCase() === include.paidOutcome) excluded.add(s.key);
    }
  }
  let expressible = true;
  if (excluded.size) {
    members.push({ [spec.field]: { $nin: [...excluded] } });
    const stageKey = cap.fields.find((f) => f.path === spec.field || f.key === spec.field)?.key;
    if (stageKey && excluded.size <= MAX_CONDITION_VALUES) drillWhere.push({ f: stageKey, op: 'nin', v: [...excluded] });
    else expressible = false;
  }
  return { members, drillWhere: expressible ? drillWhere : null, excluded, ...(pipelineKeys ? { pipelineKeys } : {}) };
}

/** A stored amount as a number: 0 when it is missing or not a number (as the invoice's balanceDue reads it). */
function amount(path: string): Record<string, unknown> {
  return { $convert: { input: `$${path}`, to: 'double', onError: 0, onNull: 0 } };
}

/** What each record adds to its total. */
function valueExpression(cap: ModuleCap, metric: MetricDef): Record<string, unknown> {
  const value = metric.value;
  if (value.kind === 'field') return amount(pathOf(cap, value.field));
  // The invoice's balanceDue: max(0, round(total - paid, 2)).
  return { $max: [0, { $round: [{ $subtract: [amount(pathOf(cap, value.total)), amount(pathOf(cap, value.paid))] }, 2] }] };
}

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function groupKeyOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

/** The caller's currency: its branch's, else the org's. */
function ownCurrency(currencies: CompanyCurrencies, branchId: string | null): string {
  return (branchId ? currencies.byBranch.get(branchId.toLowerCase()) : undefined) ?? currencies.org;
}

/** The currencies the rows can be in, in the order they are shown: the
 * caller's (its branch's, else the org's) first, then A to Z. */
function currencyOrder(currencies: CompanyCurrencies, branchId: string | null): string[] {
  const own = ownCurrency(currencies, branchId);
  const others = [...new Set([currencies.org, ...currencies.byBranch.values()])].filter((c) => c !== own).sort();
  return [own, ...others];
}

/** Each record's own currency (a deal's), trimmed and upper-cased; a blank or
 * missing one is its company's (currencyExpressionOf), as a deal's pre-save
 * fills it (the Deals screen counts such a deal in the viewer's currency). */
function recordCurrencyExpression(path: string, currencies: CompanyCurrencies): Record<string, unknown> {
  return {
    $let: {
      vars: { c: { $toUpper: { $trim: { input: { $convert: { input: `$${path}`, to: 'string', onError: '', onNull: '' } } } } } },
      in: { $cond: [{ $eq: ['$$c', ''] }, currencyExpressionOf(currencies), '$$c'] },
    },
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** The stage key a plan value names, as the compiler reads it (the key, in
 * any case or spacing, or its label); null when it names none or several. */
function stageKeyOf(status: StatusInfo | null, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || !status) return null;
  const v = raw.trim();
  if (status.options.has(v)) return v;
  const found = [...status.options].filter(([key, option]) => norm(key) === norm(v) || norm(option.label) === norm(v)).map(([key]) => key);
  return found.length === 1 ? found[0] : null;
}

/** A stage key in words ("cancelled"). */
function stageWords(status: StatusInfo | null, key: string): string {
  return (status?.options.get(key)?.label ?? key.replace(/[_-]+/g, ' ')).toLowerCase();
}

function orWords(parts: readonly string[]): string {
  return parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** The note for a plan whose own conditions ask only for records the metric
 * leaves out ("purchase amount of cancelled invoices", "refunded payments
 * received", "outstanding of paid invoices"): its 0 is right, but says
 * nothing, and the list behind it would not be its records. null when the
 * plan asks for nothing of the kind. Checked: eq / in on the stage field (or
 * on the field an `equals` metric counts by), ne / nin of the value it counts,
 * and the paid flag eq true; the grammar writes these. Not for the deal totals
 * (open, outcome): null. */
function leftOutNotice(metric: MetricDef, cap: ModuleCap, plan: QueryPlan, membership: Membership, status: StatusInfo | null): QueryNotice | null {
  const include = metric.include;
  if (include.kind === 'open' || include.kind === 'outcome') return null;
  const stage = stageSpecFor(cap)?.field;
  const plural = cap.labels.plural.toLowerCase();
  const isField = (key: string, field: string | undefined) => !!field && (key === field || fieldFor(cap, key)?.path === pathOf(cap, field));
  const keyOf = (field: string, raw: unknown) => (field === stage || pathOf(cap, field) === stage ? stageKeyOf(status, raw) : typeof raw === 'string' ? raw.trim() : null);
  let asked: string[] | null = null;
  for (const cond of plan.where ?? []) {
    if (!('f' in cond)) continue;
    const values = cond.op === 'eq' || cond.op === 'ne' ? [cond.v] : cond.op === 'in' || cond.op === 'nin' ? cond.v : [];
    if (include.kind === 'equals' && isField(cond.f, include.field)) {
      const keys = values.map((v) => keyOf(include.field, v));
      if (keys.some((k) => k === null) || !keys.length) continue;
      const positive = cond.op === 'eq' || cond.op === 'in';
      if (positive && keys.every((k) => k !== include.value)) asked = keys.map((k) => stageWords(status, k!));
      else if (!positive && keys.includes(include.value)) asked = [];
    } else if (include.kind !== 'equals' && isField(cond.f, stage) && (cond.op === 'eq' || cond.op === 'in')) {
      const keys = values.map((v) => stageKeyOf(status, v));
      if (keys.length && keys.every((k) => k !== null && membership.excluded.has(k))) asked = keys.map((k) => stageWords(status, k!));
    } else if (include.kind === 'unpaid' && isField(cond.f, include.paidFlag) && cond.op === 'eq' && (cond.v === true || cond.v === 'true')) {
      asked = [(fieldFor(cap, include.paidFlag)?.label ?? include.paidFlag).toLowerCase()];
    }
    if (asked) break;
  }
  if (!asked) return null;
  const words = orWords(asked);
  const head = include.kind === 'equals'
    ? `${metric.label} counts only ${stageWords(status, include.value)} ${plural}`
    : `${metric.label} leaves out ${words} ${plural}`;
  const ask = asked.length ? ` Ask for "${words} ${plural}" to list them.` : '';
  return { code: 'metric_leaves_out', tone: 'info', text: `${head}, so there is nothing to add up here.${ask}` };
}

/** The list behind a total: the same target, conditions, search, "mine" and
 * relation, plus `membership`, the metric's own conditions (not cancelled,
 * not paid, completed: membershipOf), so the list's total is the total's
 * record count. A membership condition the plan already has isn't repeated.
 * Undefined when that would take more conditions than a plan holds. */
export function metricDrillPlan(plan: QueryPlan, membership: readonly Cond[]): QueryPlan | undefined {
  const own = plan.where ?? [];
  const seen = new Set(own.map((cond) => JSON.stringify(cond)));
  const more = (JSON.parse(JSON.stringify(membership)) as Cond[]).filter((cond) => !seen.has(JSON.stringify(cond)));
  const where = [...own, ...more];
  if (where.length > MAX_PLAN_CONDITIONS) return undefined;
  return {
    v: 1, op: 'list', target: plan.target,
    ...(where.length ? { where } : {}),
    ...(plan.search ? { search: plan.search } : {}),
    ...(plan.mine ? { mine: plan.mine } : {}),
    ...(plan.relation ? { relation: plan.relation } : {}),
  };
}

/** One row as read: its group value, currency (the $facet form), total and record count. */
interface RawRow { k?: unknown; c?: unknown; total?: unknown; n?: unknown }

/** How many of the records a total adds up sit in a stage that is no longer
 * in the module's pipeline (decision N15: they are neither cancelled nor
 * final, so they count, as Daily Events counts them), as a note; none when
 * there are none. `conditions`: the read's members, the metric's included. A
 * count that fails adds nothing (logged). */
async function removedStagesNotices(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[], field: string, keys: ReadonlySet<string>,
): Promise<QueryNotice[]> {
  try {
    const n = await scopedCount(cap, ctx, [...conditions, { [field]: { $nin: [...keys, '', null] } }]);
    if (!(typeof n === 'number' && n > 0)) return [];
    const text = n === 1
      ? `1 ${cap.labels.singular.toLowerCase()} in a stage no longer in your pipeline is counted in this total.`
      : `${n} ${cap.labels.plural.toLowerCase()} in stages no longer in your pipeline are counted in this total.`;
    return [{ code: 'removed_stages_counted', tone: 'info', text }];
  } catch (err) {
    logger.warn('CRM assist: removed-stage count failed', { module: cap.key, error: (err as Error)?.message });
    return [];
  }
}

/** A named metric of `cap` (op 'aggregate', metrics [{ metric }], optional
 * group by one of the metric's groupBy fields, optional top N up to
 * MAX_METRIC_TOP, or by its own date per day, week, month, quarter or year:
 * group.by its bucketField with a bucket), over the caller's scope: one row
 * per currency, or per group value and currency, the caller's currency
 * first, largest first in each, a breakdown's top N taken in each currency;
 * by date, in each currency the `opts.maxBuckets` (default MAX_DATE_BUCKETS)
 * buckets nearest today's, oldest first, after its no-date row. `extras`: a
 * relation's (QueryExtras). Throws PlanRejectedError for a plan it can't run
 * and MineUnavailableError as executor Q does. The clock is fixed once, so
 * the conditions, the buckets kept and the outcome's `clock` agree. */
export async function executeQueryMetric(
  cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras, opts: { maxBuckets?: number } = {},
): Promise<MetricOutcome> {
  const now = ctx.now ?? new Date();
  ctx = { ...ctx, now };
  const timezone = isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC';
  const todayKey = resolveRelRange('today', timezone, now).fromKey;
  const metric = namedMetricOf(cap, plan);
  const include = metric.include;
  const by = plan.group?.by;
  const bucket = plan.group?.bucket;
  const field = by !== undefined ? fieldFor(cap, by) : undefined;
  // By date only by the metric's own date (bucketField), a date field.
  const dated = !!bucket && !!metric.bucketField && by === metric.bucketField
    && !!field && (field.kind === 'date' || field.kind === 'datetime');
  if (bucket && !dated) throw reject('group.bucket', `${metric.label} is not broken down by date.`);
  if (!dated && by !== undefined && (!field || !metric.groupBy.includes(by))) throw reject('group.by', `${metric.label} can't be broken down by "${by}".`);
  const maxBuckets = Math.max(1, Math.floor(opts.maxBuckets ?? MAX_DATE_BUCKETS));
  const top = dated ? maxBuckets : field ? Math.min(Math.max(Math.floor(plan.top ?? DEFAULT_METRIC_TOP), 1), MAX_METRIC_TOP) : MAX_METRIC_TOP;

  // By date with a window on that date, which (unlike a receipt's payment date)
  // has no undated note of its own (FieldCap.undatedNotice): the same members
  // without that window, to say how many records it leaves out for having no
  // date (as execute-query.ts undatedWindow does for the flagged dates).
  const windowed = (cond: Cond) => 'f' in cond && cond.f === field?.key && WINDOW_OPS.has(cond.op);
  const ownUndated = dated && !field!.undatedNotice && (plan.where ?? []).some(windowed);
  const rest = (plan.where ?? []).filter((cond) => !windowed(cond));
  const [prepared, membership, currencies, unwindowed] = await Promise.all([
    prepareQuery(cap, plan, ctx, extras),
    membershipOf(metric, cap, ctx.tenantId),
    companyCurrenciesFor(ctx),
    ownUndated
      ? compileQueryConditions(cap, { ...plan, where: rest.length ? rest : undefined }, ctx).catch(() => null)
      : Promise.resolve(null),
  ]);
  // The group key: the field's stored value, or the first day of its date
  // bucket in the tenant's timezone, as executor Q's breakdowns read it. A
  // bucket's distance from today's (null for the no-date row) picks the ones kept.
  let key: unknown = field ? `$${field.path}` : null;
  const distance: Record<string, unknown>[] = [];
  if (dated) {
    key = dateBucketExpression(field!.path, dateRuleOf(field!), timezone, bucket!);
    distance.push({ $addFields: { d: bucketDistance(bucket!, todayKey, '$_id.k') } });
  }
  const currencyKey = metric.currency ? recordCurrencyExpression(pathOf(cap, metric.currency.field), currencies) : currencyExpressionOf(currencies);
  const group = { $group: { _id: { k: key, c: currencyKey }, total: { $sum: valueExpression(cap, metric) }, n: { $sum: 1 } } };
  const order = currencyOrder(currencies, ctx.branchId);
  const mine = ownCurrency(currencies, ctx.branchId);
  let stages: Record<string, unknown>[];
  if (metric.currency) {
    // Each record's own currency, known only after the read: every currency's
    // rows ranked (by date: nearest today's first) and cut in one pipeline,
    // never ranked against another currency's. By date, each currency's first
    // and last dated bucket too ($min and $max skip the no-date row's null).
    // The caller's currency is never the one cut: it sorts first, then A to Z,
    // and one currency more than are kept tells whether any was left out.
    const span = dated ? { lo: { $min: '$_id.k' }, hi: { $max: '$_id.k' } } : {};
    stages = [
      group, ...distance,
      { $sort: dated ? { '_id.c': 1, d: 1, '_id.k': 1 } : { '_id.c': 1, total: -1, '_id.k': 1 } },
      { $group: { _id: '$_id.c', rows: { $push: { k: '$_id.k', total: '$total', n: '$n' } }, groups: { $sum: 1 }, ...span } },
      { $project: { rows: { $slice: ['$rows', dated ? maxBuckets + 1 : field ? top : 1] }, groups: 1, ...(dated ? { lo: 1, hi: 1 } : {}) } },
      { $addFields: { own: { $cond: [{ $eq: ['$_id', { $literal: mine }] }, 0, 1] } } },
      { $sort: { own: 1, _id: 1 } },
      { $limit: MAX_RECORD_CURRENCIES + 1 },
    ];
  } else {
    // One pipeline per currency the rows can be in: each ranks and cuts its own
    // rows, so an amount is never ranked against another currency's. By date,
    // the buckets nearest today's, one more than are kept: room for the
    // no-date row, whose distance is null and so comes first; and the
    // currency's first and last dated bucket, however many are kept.
    const facets: Record<string, Record<string, unknown>[]> = { groups: [{ $count: 'n' }] };
    order.forEach((currency, i) => {
      facets[`r${i}`] = dated
        ? [{ $match: { '_id.c': currency } }, { $sort: { d: 1, '_id.k': 1 } }, { $limit: maxBuckets + 1 }]
        : [{ $match: { '_id.c': currency } }, { $sort: { total: -1, '_id.k': 1 } }, { $limit: top }];
      facets[`n${i}`] = [{ $match: { '_id.c': currency } }, { $count: 'n' }];
      if (dated) {
        facets[`s${i}`] = [
          { $match: { '_id.c': currency, '_id.k': { $ne: null } } },
          { $group: { _id: null, lo: { $min: '$_id.k' }, hi: { $max: '$_id.k' } } },
        ];
      }
    });
    stages = [group, ...distance, { $facet: facets }];
  }
  const own = membership.members;
  const conditions = [...prepared.conditions, ...own];
  const spec = stageSpecFor(cap);
  // Records the window leaves out for having no date, among the ones this metric counts ("completed receipts", "won deals").
  const counted = include.kind === 'equals' ? stageWords(prepared.status, include.value) : include.kind === 'outcome' ? include.outcome : '';
  const what = counted
    ? { one: `${counted} ${cap.labels.singular.toLowerCase()}`, many: `${counted} ${cap.labels.plural.toLowerCase()}` }
    : undefined;
  const [result, read, undated, removed, ownUndatedNotes] = await Promise.all([
    scopedAggregate(cap, ctx, conditions, stages),
    loadReadContext(cap, moduleDefFor(cap), ctx, prepared.status),
    prepared.undated ? undatedNotices(cap, ctx, prepared.undated, { members: own, ...(what ? { what } : {}) }) : Promise.resolve([]),
    membership.pipelineKeys && spec ? removedStagesNotices(cap, ctx, conditions, spec.field, membership.pipelineKeys) : Promise.resolve([]),
    unwindowed && field
      ? undatedNotices(cap, ctx, { field, conditions: [...unwindowed.conditions, ...(extras?.conditions ?? [])] }, { members: own, ...(what ? { what } : {}) })
      : Promise.resolve([]),
  ]);

  /** A bucket's day key as read, or null. */
  const spanKey = (value: unknown): string | null => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const spanOf = (lo: unknown, hi: unknown): { lo: string; hi: string } | undefined => {
    const [a, b] = [spanKey(lo), spanKey(hi)];
    return a && b ? { lo: a, hi: b } : undefined;
  };
  // Each currency's rows as read, in the order they are shown.
  const sections: Array<{ currency: string | null; raw: RawRow[]; count: number | null; span?: { lo: string; hi: string } }> = [];
  let groups: number | null = null;
  let currenciesLeftOut = false;
  if (metric.currency) {
    const all = result as Array<{ _id?: unknown; rows?: unknown; groups?: unknown; lo?: unknown; hi?: unknown }>;
    // One currency more than are kept came back: the rest are left out, and a note says so.
    currenciesLeftOut = all.length > MAX_RECORD_CURRENCIES;
    const docs = all.slice(0, MAX_RECORD_CURRENCIES);
    const rank = (c: string | null) => (c === mine ? 0 : c === null ? 2 : 1);
    sections.push(...docs
      .map((doc) => {
        const span = dated ? spanOf(doc.lo, doc.hi) : undefined;
        return {
          currency: typeof doc._id === 'string' && doc._id ? doc._id : null,
          raw: Array.isArray(doc.rows) ? doc.rows as RawRow[] : [],
          count: finite(doc.groups),
          ...(span ? { span } : {}),
        };
      })
      // The caller's currency first, then A to Z.
      .sort((a, b) => rank(a.currency) - rank(b.currency) || ((a.currency ?? '') < (b.currency ?? '') ? -1 : (a.currency ?? '') > (b.currency ?? '') ? 1 : 0)));
  } else {
    const doc = (result[0] ?? {}) as Record<string, unknown>;
    order.forEach((currency, i) => {
      const raw = Array.isArray(doc[`r${i}`]) ? doc[`r${i}`] as Array<{ _id?: { k?: unknown; c?: unknown }; total?: unknown; n?: unknown }> : [];
      const bounds = dated && Array.isArray(doc[`s${i}`]) ? (doc[`s${i}`] as Array<{ lo?: unknown; hi?: unknown }>)[0] : undefined;
      const span = bounds ? spanOf(bounds.lo, bounds.hi) : undefined;
      sections.push({
        currency,
        raw: raw.map((row) => ({ k: row._id?.k, c: row._id?.c, total: row.total, n: row.n })),
        count: Array.isArray(doc[`n${i}`]) ? finite((doc[`n${i}`] as Array<{ n?: unknown }>)[0]?.n) : null,
        ...(span ? { span } : {}),
      });
    });
    groups = Array.isArray(doc.groups) ? finite((doc.groups[0] as { n?: unknown } | undefined)?.n) : null;
  }
  const byKey = (a: RawRow, b: RawRow): number => {
    const x = groupKeyOf(a.k) ?? '';
    const y = groupKeyOf(b.k) ?? '';
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const rows: MetricRow[] = [];
  const groupsByCurrency: MetricOutcome['groupsByCurrency'] = [];
  for (const { currency, raw, count, span } of sections) {
    // By date: the no-date row, then the buckets kept (read nearest today's first), oldest first.
    const kept = dated
      ? [...raw.filter((row) => groupKeyOf(row.k) === null), ...raw.filter((row) => groupKeyOf(row.k) !== null).slice(0, maxBuckets).sort(byKey)]
      : raw;
    const shown = kept.map((row): MetricRow => {
      const total = finite(row.total);
      return {
        key: groupKeyOf(row.k),
        currency: typeof row.c === 'string' && row.c ? row.c : currency,
        value: total === null ? null : Math.round(total * 100) / 100,
        count: finite(row.n) ?? 0,
      };
    });
    if (!shown.length && !count) continue;
    rows.push(...shown);
    groupsByCurrency.push({ currency, groups: Math.max(count ?? 0, shown.length), ...(span ? { span } : {}) });
  }
  const totalGroups = Math.max(groups ?? 0, groupsByCurrency.reduce((sum, g) => sum + g.groups, 0), rows.length);

  const leftOut = leftOutNotice(metric, cap, plan, membership, prepared.status);
  const noOutcome: QueryNotice[] = membership.noOutcome && include.kind === 'outcome'
    ? [{
      code: 'metric_no_outcome', tone: 'info',
      text: `No ${cap.labels.singular.toLowerCase()} stage is tagged ${include.outcome} in your Pipeline & Stages settings, so there is no ${metric.label.toLowerCase()}.`,
    }]
    : [];
  const moreCurrencies: QueryNotice[] = currenciesLeftOut
    ? [{ code: 'more_currencies', tone: 'info', text: 'Amounts in more currencies are not shown.' }]
    : [];
  // More currencies than were read: no one list behind what is shown.
  const drill = groupsByCurrency.length <= 1 && !currenciesLeftOut && !leftOut && membership.drillWhere
    ? metricDrillPlan(plan, membership.drillWhere) : undefined;
  return {
    metric, rows, totalGroups, groupsByCurrency, top, read, implied: prepared.implied,
    notices: [...prepared.notices, ...undated, ...ownUndatedNotes, ...(leftOut ? [leftOut] : []), ...noOutcome, ...removed, ...moreCurrencies],
    ...(prepared.partialReasons?.length ? { partialReasons: prepared.partialReasons } : {}),
    basis: metric.basis,
    ...(drill ? { drill } : {}),
    clock: { timezone, now, todayKey },
    ...(dated ? { bucket: bucket! } : {}),
  };
}
