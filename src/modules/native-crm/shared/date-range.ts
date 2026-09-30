/** Shared date-range resolution for dashboard-style stats endpoints — one
 * place to compute "what does Today/Week/Month/... actually mean" instead
 * of duplicating the math per module. Server-local time, not per-tenant
 * timezone-aware — an accepted simplification for now, not an oversight. */

export type DateRangeKey = 'today' | 'week' | 'month' | '3months' | '6months' | '1year' | 'custom';

export interface ResolvedDateRange {
  start: Date;
  end: Date;
}

const RANGE_KEYS: readonly string[] = ['today', 'week', 'month', '3months', '6months', '1year', 'custom'];
const ROLLING_MONTHS: Record<string, number> = { '3months': 3, '6months': 6, '1year': 12 };

/** Undefined/unrecognized input returns null, meaning "apply no date
 * filter at all" — every existing caller that never sends `?range=` keeps
 * getting exactly today's all-time behavior, unchanged.
 * `customFrom`/`customTo` (ISO date strings) are only read when
 * range === 'custom'; an invalid or incomplete pair also resolves to null
 * (no filter), same as any other unrecognized input — callers already
 * treat null as "don't filter," so a malformed custom range degrades to
 * "show everything" rather than a 500. */
export function resolveDateRange(range?: string, customFrom?: string, customTo?: string): ResolvedDateRange | null {
  if (!range || !RANGE_KEYS.includes(range)) return null;

  const now = new Date();
  const end = new Date(now);

  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  if (range === 'week') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    // ISO week — Monday start. getDay(): 0=Sun..6=Sat.
    const day = start.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diffToMonday);
    return { start, end };
  }

  if (range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { start, end };
  }

  if (range in ROLLING_MONTHS) {
    // Rolling N-month window ending now (not calendar-aligned) — e.g.
    // "6months" on Sep 28 starts Mar 28, not Apr 1. JS Date normalizes
    // month underflow into the prior year automatically.
    const n = ROLLING_MONTHS[range];
    const start = new Date(now.getFullYear(), now.getMonth() - n, now.getDate(), 0, 0, 0, 0);
    return { start, end };
  }

  // 'custom'
  if (!customFrom || !customTo) return null;
  const start = new Date(customFrom);
  start.setHours(0, 0, 0, 0);
  const customEnd = new Date(customTo);
  customEnd.setHours(23, 59, 59, 999);
  if (Number.isNaN(start.getTime()) || Number.isNaN(customEnd.getTime()) || start > customEnd) return null;
  return { start, end: customEnd };
}

/** The same-length window immediately preceding the current one, for trend
 * deltas — not a rolling "N days ago", an actual calendar-aligned prior
 * period (yesterday / prior 7 days / prior calendar month / prior N-month
 * block). Returns null whenever resolveDateRange(range) would, so a trend
 * can never be computed against an undefined baseline — and always null
 * for 'custom', since an arbitrary user-picked range has no natural
 * "prior period" to compare against. */
export function resolvePriorDateRange(range?: string, customFrom?: string, customTo?: string): ResolvedDateRange | null {
  const current = resolveDateRange(range, customFrom, customTo);
  if (!current || range === 'custom') return null;

  if (range === 'today') {
    const start = new Date(current.start);
    start.setDate(start.getDate() - 1);
    const end = new Date(current.end);
    end.setDate(end.getDate() - 1);
    return { start, end };
  }

  if (range === 'week') {
    const start = new Date(current.start);
    start.setDate(start.getDate() - 7);
    const end = new Date(current.end);
    end.setDate(end.getDate() - 7);
    return { start, end };
  }

  if (range === 'month') {
    // The full previous calendar month, not a rolling 30 days.
    const priorMonthStart = new Date(current.start.getFullYear(), current.start.getMonth() - 1, 1, 0, 0, 0, 0);
    const priorMonthEnd = new Date(current.start.getTime() - 1); // 23:59:59.999 on the last day of the prior month
    return { start: priorMonthStart, end: priorMonthEnd };
  }

  // 3months/6months/1year — the equal-length rolling block immediately
  // before the current one.
  const n = ROLLING_MONTHS[range!];
  const priorStart = new Date(current.start.getFullYear(), current.start.getMonth() - n, current.start.getDate(), 0, 0, 0, 0);
  const priorEnd = new Date(current.start.getTime() - 1);
  return { start: priorStart, end: priorEnd };
}

/** Applies a resolved range to a Mongo filter object in place — a no-op
 * when `resolved` is null, so callers can always call this unconditionally. */
export function applyDateRangeToFilter(
  filter: Record<string, unknown>,
  field: string,
  resolved: ResolvedDateRange | null,
): void {
  if (resolved) filter[field] = { $gte: resolved.start, $lte: resolved.end };
}

export interface DailyPoint { date: string; count: number; }

/** Zero-fills a sparse `{$dateToString: '%Y-%m-%d'} → count` aggregation
 * result so a KPI sparkline always gets exactly `days` contiguous points —
 * a day with genuinely zero records must render as a real zero point, not
 * a gap (matches the "no fake data, but no misleading gaps either" rule).
 * `days` counts backward from today inclusive (days=14 → today and the
 * preceding 13 days). */
export function fillDailySeries(raw: { _id: string; count: number }[], days: number): DailyPoint[] {
  const byDate = new Map(raw.map((r) => [r._id, r.count]));
  const out: DailyPoint[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));

  for (let i = 0; i < days; i++) {
    const key = cursor.toISOString().slice(0, 10); // YYYY-MM-DD, matches $dateToString's format
    out.push({ date: key, count: byDate.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Fixed 14-day lookback for KPI sparklines — deliberately independent of
 * whatever date range is selected for the main KPI number (the sparkline
 * shows "recent shape of activity" as a constant companion visual, not
 * something that flips to a single bar when "Today" is picked). */
export const SPARKLINE_DAYS = 14;

export function sparklineWindowStart(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (SPARKLINE_DAYS - 1));
  return start;
}
