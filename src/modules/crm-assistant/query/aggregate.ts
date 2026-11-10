import type { Cond, DateExpr, QueryPlan } from '../contracts/plan';
import type { ModuleCap } from '../registry/types';
import type { ExecContext } from './execute-list';
import type { QueryExtras, QueryGroupsOutcome } from './execute-query';
import { compileQueryConditions, executeQueryGroups } from './execute-query';
import { dateBucketExpression, dateExprToKey, dateRuleOf, fieldFor, resolveRelRange } from './compile';
import { scopedAggregate, scopedCount } from './scoped-match';
import { addDaysToKey } from '../../daily-events/daily-events.time';
import { isValidTimeZone } from '../../native-crm/shared/date-range';
import { logger } from '../../../utils/logger';

/* Count breakdowns read for a chart (Increment 8): date buckets in the
 * tenant's timezone, their zero fill and the window a plan puts on the
 * bucketed date. Reads only through execute-query.ts and scoped-match.ts.
 *
 * A bucket is what dateBucketExpression (compile.ts) groups by: the first day
 * (YYYY-MM-DD) of the record's tenant-local day, week (from Monday), month,
 * calendar quarter or year. The arithmetic here works on those day keys as
 * UTC calendar days, so it truncates exactly as the database does. A chart
 * draws every bucket of its range, an empty one as 0 (the read ran): the
 * window on the bucketed date, else the first to the last bucket that has
 * records; at most MAX_CHART_POINTS, the ones nearest today's bucket.
 *
 * executeChartGroups is executor Q's count breakdown (executeQueryGroups,
 * room for MAX_CHART_POINTS date buckets) with, in the same Promise.all, what
 * a chart needs besides: how many records a window on the bucketed date
 * leaves out for having no date, and the first and last dated bucket when the
 * window leaves the range open (the read itself keeps only the buckets nearest
 * today). One clock for all of them. */

export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** At most this many points on one chart (CHART_CAPS.categories). */
export const MAX_CHART_POINTS = 50;

const DAY_MS = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ── Buckets (pure) ────────────────────────────────────────────────────── */

/** The day key as a count of UTC days since 1970-01-01. */
function daysOf(dayKey: string): number {
  const m = DAY_KEY.exec(dayKey);
  if (!m) throw new RangeError(`"${dayKey}" is not a day key`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function keyOfUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Which bucket holds the day, counted from 1970: days; weeks from Monday
 * (1970-01-01 was a Thursday, so Monday 1969-12-29 starts week 0); months,
 * quarters and years from year 0. Consecutive buckets differ by 1. */
function ordinalOf(dayKey: string, bucket: Bucket): number {
  const days = daysOf(dayKey);
  const [year, month] = dayKey.split('-').map(Number);
  switch (bucket) {
    case 'day': return days;
    case 'week': return Math.floor((days + 3) / 7);
    case 'month': return year * 12 + (month - 1);
    case 'quarter': return year * 4 + Math.floor((month - 1) / 3);
    case 'year': return year;
    default: throw new RangeError(`Unknown bucket "${String(bucket)}"`);
  }
}

/** The first day of the bucket at `ordinal` (ordinalOf). */
function startOfOrdinal(ordinal: number, bucket: Bucket): string {
  switch (bucket) {
    case 'day': return keyOfUtc(ordinal * DAY_MS);
    case 'week': return keyOfUtc((ordinal * 7 - 3) * DAY_MS);
    case 'month': return keyOfUtc(Date.UTC(Math.floor(ordinal / 12), ordinal % 12, 1));
    case 'quarter': return keyOfUtc(Date.UTC(Math.floor(ordinal / 4), (ordinal % 4) * 3, 1));
    case 'year': return keyOfUtc(Date.UTC(ordinal, 0, 1));
    default: throw new RangeError(`Unknown bucket "${String(bucket)}"`);
  }
}

/** The first day (YYYY-MM-DD) of the bucket holding dayKey, as dateBucketExpression truncates it (weeks from Monday). */
export function bucketStartOf(dayKey: string, bucket: Bucket): string {
  return startOfOrdinal(ordinalOf(dayKey, bucket), bucket);
}

/** The last day of the bucket that starts on startKey. */
export function bucketEndOf(startKey: string, bucket: Bucket): string {
  return keyOfUtc((daysOf(startOfOrdinal(ordinalOf(startKey, bucket) + 1, bucket)) - 1) * DAY_MS);
}

/** The bucket starts to draw (zero fill, B5.3), oldest first, at most `max` (those nearest todayKey's bucket when cut).
 * The range: the window's first bucket, else the oldest dated one; to the
 * window's last bucket, else the newest dated one (`stopAtToday`: the field is
 * the creation date, never in the future, so the fill ends at today's bucket).
 * A bucket that has records is always in the range. Past `max`, the `max`
 * buckets nearest today's (a tie goes to the earlier one) and `cut`; `total`:
 * every bucket of the range. No dated key and no window: none. */
export function chartBuckets(
  dated: readonly string[], bucket: Bucket, window: { fromKey?: string; toKey?: string } | null, todayKey: string, max: number,
  opts: { stopAtToday?: boolean } = {},
): { keys: string[]; total: number; cut: boolean } {
  const held = dated.filter((key) => DAY_KEY.test(key)).map((key) => ordinalOf(key, bucket));
  const today = ordinalOf(todayKey, bucket);
  const oldest = held.length ? Math.min(...held) : undefined;
  const newest = held.length ? Math.max(...held) : undefined;
  let hi = window?.toKey ? ordinalOf(window.toKey, bucket) : newest;
  if (opts.stopAtToday) hi = hi === undefined ? today : Math.min(hi, today);
  let lo = window?.fromKey ? ordinalOf(window.fromKey, bucket) : oldest ?? hi;
  if (hi === undefined) hi = lo;
  if (lo === undefined || hi === undefined) return { keys: [], total: 0, cut: false };
  // Never leave out a bucket that has records (a creation date in the future is still drawn).
  if (oldest !== undefined && newest !== undefined) {
    lo = Math.min(lo, oldest);
    hi = Math.max(hi, newest);
  }
  if (hi < lo) return { keys: [], total: 0, cut: false };
  const total = hi - lo + 1;
  const most = Math.max(1, Math.floor(max));
  let from = lo;
  let to = hi;
  if (total > most) {
    // Centred on today's bucket (clamped into the range), one more before it than after it.
    const centre = Math.min(Math.max(today, lo), hi);
    from = centre - Math.ceil((most - 1) / 2);
    to = from + most - 1;
    if (from < lo) { from = lo; to = lo + most - 1; }
    if (to > hi) { to = hi; from = hi - most + 1; }
  }
  const keys: string[] = [];
  for (let o = from; o <= to; o += 1) keys.push(startOfOrdinal(o, bucket));
  return { keys, total, cut: total > most };
}

/* ── The window on the bucketed date ───────────────────────────────────── */

function isDateExpr(value: unknown): value is DateExpr {
  return !!value && typeof value === 'object' && !Array.isArray(value) && ('date' in value || 'rel' in value);
}

/** A condition that puts fieldKey in a date window: within a range, or
 * between, after or before a date (a number value is not a date). */
function isWindowOn(cond: Cond, fieldKey: string): boolean {
  if (!('f' in cond) || cond.f !== fieldKey) return false;
  switch (cond.op) {
    case 'within': return true;
    case 'between': return isDateExpr(cond.v[0]) && isDateExpr(cond.v[1]);
    case 'gt': case 'gte': case 'lt': case 'lte': return isDateExpr(cond.v);
    default: return false;
  }
}

/** The window the plan's own where puts on fieldKey (within; between; gt, gte, lt, lte with a DateExpr) as inclusive tenant-local day keys; null when none.
 * Several conditions narrow to their intersection; a date that doesn't exist
 * is left out (the validator refuses it before any read). */
export function windowOnField(plan: QueryPlan, fieldKey: string, timezone: string, now: Date): { fromKey?: string; toKey?: string } | null {
  let fromKey: string | undefined;
  let toKey: string | undefined;
  const narrow = (from?: string, to?: string) => {
    if (from && (!fromKey || from > fromKey)) fromKey = from;
    if (to && (!toKey || to < toKey)) toKey = to;
  };
  const keyOf = (expr: DateExpr) => dateExprToKey(expr, timezone, now);
  for (const cond of plan.where ?? []) {
    if (!isWindowOn(cond, fieldKey) || !('f' in cond)) continue;
    try {
      switch (cond.op) {
        case 'within': {
          const range = resolveRelRange(cond.v, timezone, now);
          narrow(range.fromKey, range.toKey);
          break;
        }
        case 'between': {
          const [a, b] = [keyOf(cond.v[0] as DateExpr), keyOf(cond.v[1] as DateExpr)];
          narrow(a < b ? a : b, a < b ? b : a);
          break;
        }
        case 'gte': narrow(keyOf(cond.v as DateExpr)); break;
        case 'gt': narrow(addDaysToKey(keyOf(cond.v as DateExpr), 1)); break;
        case 'lte': narrow(undefined, keyOf(cond.v as DateExpr)); break;
        case 'lt': narrow(undefined, addDaysToKey(keyOf(cond.v as DateExpr), -1)); break;
        default: break;
      }
    } catch {
      // Not a calendar date: no window from it.
    }
  }
  if (!fromKey && !toKey) return null;
  return { ...(fromKey ? { fromKey } : {}), ...(toKey ? { toKey } : {}) };
}

/** The plan without its window conditions on fieldKey. */
export function withoutWindowOn(plan: QueryPlan, fieldKey: string): QueryPlan {
  const { where, ...rest } = plan;
  const kept = (where ?? []).filter((cond) => !isWindowOn(cond, fieldKey));
  return kept.length ? { ...rest, where: kept } : rest;
}

/* ── The read ──────────────────────────────────────────────────────────── */

export interface ChartGroupsOutcome extends QueryGroupsOutcome {
  bucket?: Bucket;
  window: { fromKey?: string; toKey?: string } | null;
  todayKey: string;
  /** A window on the bucketed date: records with no date there (null: the count failed). Absent: no such window, or the field already says it (FieldCap.undatedNotice). */
  undatedOutside?: number | null;
  /** Date buckets whose window leaves an end open: the first and last bucket
   * that has records (the read keeps only the buckets nearest today's), as a
   * chart's range. null: the read failed, or no record has a date. Absent:
   * not a date breakdown, or the window closes both ends. */
  datedSpan?: { lo: string; hi: string } | null;
}

/** A count breakdown for a chart: executeQueryGroups keeping up to
 * MAX_CHART_POINTS date buckets and, by date, in the same Promise.all: the
 * records a window on the bucketed date leaves out for having no date (one
 * count, unless the field's own note says it), and the range of dated
 * buckets when the window leaves an end open (one $min / $max read). Both use
 * the read's members without that window; a failed one is logged and gives
 * null, never a number. Throws as executeQueryGroups does. */
export async function executeChartGroups(cap: ModuleCap, plan: QueryPlan, ctx: ExecContext, extras?: QueryExtras): Promise<ChartGroupsOutcome> {
  // executeQueryGroups refuses a group it can't count by before anything is read.
  const field = plan.group ? fieldFor(cap, plan.group.by) : undefined;
  const bucket = field && (field.kind === 'date' || field.kind === 'datetime') ? plan.group?.bucket : undefined;
  const timezone = isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC';
  const now = ctx.now ?? new Date();
  const clocked: ExecContext = { ...ctx, now };
  const todayKey = resolveRelRange('today', timezone, now).fromKey;
  const window = field && bucket ? windowOnField(plan, field.key, timezone, now) : null;
  // A field flagged undatedNotice already says it (execute-query.ts noticesFor).
  const countUndated = !!field && !!bucket && !!window && !field.undatedNotice;
  const spanWanted = !!field && !!bucket && (!window?.fromKey || !window?.toKey);
  const members = field && (countUndated || spanWanted)
    ? compileQueryConditions(cap, withoutWindowOn(plan, field.key), clocked).then((c) => [...c.conditions, ...(extras?.conditions ?? [])])
    : null;
  const undatedCount = async (): Promise<number | null> => {
    try {
      const n = await scopedCount(cap, clocked, [...(await members!), { [field!.path]: { $not: { $type: 'date' } } }]);
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    } catch (err) {
      logger.warn('CRM assist: chart undated count failed', { module: cap.key, error: (err as Error)?.message });
      return null;
    }
  };
  const spanRead = async (): Promise<{ lo: string; hi: string } | null> => {
    try {
      const key = dateBucketExpression(field!.path, dateRuleOf(field!), timezone, bucket!);
      const rows = await scopedAggregate(cap, clocked, await members!, [{ $group: { _id: null, lo: { $min: key }, hi: { $max: key } } }]);
      const doc = rows[0] as { lo?: unknown; hi?: unknown } | undefined;
      const lo = typeof doc?.lo === 'string' && DAY_KEY.test(doc.lo) ? doc.lo : null;
      const hi = typeof doc?.hi === 'string' && DAY_KEY.test(doc.hi) ? doc.hi : null;
      return lo && hi ? { lo, hi } : null;
    } catch (err) {
      logger.warn('CRM assist: chart date range read failed', { module: cap.key, error: (err as Error)?.message });
      return null;
    }
  };
  const [result, undatedOutside, datedSpan] = await Promise.all([
    executeQueryGroups(cap, plan, clocked, extras, { maxDateBuckets: MAX_CHART_POINTS }),
    countUndated ? undatedCount() : Promise.resolve(undefined),
    spanWanted ? spanRead() : Promise.resolve(undefined),
  ]);
  return {
    ...result, ...(bucket ? { bucket } : {}), window, todayKey,
    ...(countUndated ? { undatedOutside: undatedOutside ?? null } : {}),
    ...(spanWanted ? { datedSpan: datedSpan ?? null } : {}),
  };
}
