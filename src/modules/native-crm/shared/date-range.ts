/** Shared date-range resolution for dashboard-style stats endpoints — one
 * place to compute "what does Today/Week/Month/... actually mean" instead
 * of duplicating the math per module. Server-local time, not per-tenant
 * timezone-aware — an accepted simplification for now, not an oversight. */

import { zonedTimeToUtc, todayInTimezone } from './timezone';

export type DateRangeKey = 'today' | 'week' | 'month' | 'this_month' | '3months' | '6months' | '1year' | 'custom' | 'exact';

export interface ResolvedDateRange {
  start: Date;
  end: Date;
}

const RANGE_KEYS: readonly string[] = ['today', 'week', 'month', 'this_month', '3months', '6months', '1year', 'custom'];
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
  // 'exact': customFrom/customTo are full ISO instants used as given, with
  // no server-local midnight rounding. Only the internal CRM assistant
  // gateway sends it (its tenant-timezone windows are computed by
  // resolveTenantDateWindow below), so every existing key still behaves
  // exactly as before. Invalid or incomplete input means no filter, the
  // same as 'custom'.
  if (range === 'exact') {
    if (!customFrom || !customTo) return null;
    const start = new Date(customFrom);
    const end = new Date(customTo);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
    return { start, end };
  }
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

  if (range === 'month' || range === 'this_month') {
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
  if (!current || range === 'custom' || range === 'exact') return null;

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

/** Tenant-timezone-aware counterpart to resolveDateRange('today', ...)
 * above — deliberately NOT a modification of resolveDateRange itself,
 * which stays exactly as-is (server-local) for its many existing callers.
 * Only 'today' is timezone-sensitive enough to matter for the use case
 * this was built for (the CRM assistant's "what's happening today?"
 * agenda, Increment 3b) — a record due at 11:30pm in a tenant's own
 * timezone must land on today, not get pushed to tomorrow by comparing
 * against the SERVER's midnight instead. Reuses the exact same, already-
 * proven zonedTimeToUtc wall-clock math availability.service.ts's real
 * booking feature already depends on — not a second, divergent
 * implementation. */
export function resolveDateRangeForTenant(timeZone: string): ResolvedDateRange {
  const { year, month0, day } = todayInTimezone(timeZone);
  const start = zonedTimeToUtc(year, month0, day, 0, 0, timeZone);
  // 23:59:59.999 local, built the same way (minute-precision zonedTimeToUtc
  // plus the remaining 59.999s added afterward) rather than inventing a
  // separate end-of-day helper.
  const end = new Date(zonedTimeToUtc(year, month0, day, 23, 59, timeZone).getTime() + 59_999);
  return { start, end };
}

/** Named date windows the internal CRM assistant gateway accepts
 * (GET /api/internal/crm-list and /crm-count). */
export const TENANT_WINDOW_RANGES = ['today', 'this_week', 'this_month', 'last_7_days', 'next_7_days', 'custom'] as const;
export type TenantWindowRange = typeof TENANT_WINDOW_RANGES[number];

/** True when `timeZone` is an IANA zone this runtime understands. */
export function isValidTimeZone(timeZone: string | undefined | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Strict YYYY-MM-DD that is also a real calendar date (no 2026-02-30). */
export function parseIsoCalendarDate(value: string | undefined | null): { year: number; month0: number; day: number } | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month0, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month0 || probe.getUTCDate() !== day) return null;
  return { year, month0, day };
}

/** Calendar-day arithmetic that never touches the server's own timezone. */
function shiftCalendarDay(d: { year: number; month0: number; day: number }, deltaDays: number) {
  const t = new Date(Date.UTC(d.year, d.month0, d.day + deltaDays));
  return { year: t.getUTCFullYear(), month0: t.getUTCMonth(), day: t.getUTCDate() };
}

function startOfLocalDay(d: { year: number; month0: number; day: number }, timeZone: string): Date {
  return zonedTimeToUtc(d.year, d.month0, d.day, 0, 0, timeZone);
}

/** 23:59:59.999 local = one millisecond before the next local midnight,
 * which stays correct on a day that is 23 or 25 hours long (DST). */
function endOfLocalDay(d: { year: number; month0: number; day: number }, timeZone: string): Date {
  return new Date(startOfLocalDay(shiftCalendarDay(d, 1), timeZone).getTime() - 1);
}

/** Full calendar periods in the TENANT's timezone, as exact UTC instants —
 * used by the internal CRM assistant gateway only. Additive: nothing that
 * calls resolveDateRange (server-local) changes. An unknown/invalid
 * timeZone falls back to UTC; the zone actually used is returned so the
 * caller can report it.
 *   today        local 00:00 -> 23:59:59.999
 *   this_week    Monday 00:00 -> Sunday 23:59:59.999
 *   this_month   1st 00:00 -> last day 23:59:59.999
 *   last_7_days  (today-6) 00:00 -> today 23:59:59.999
 *   next_7_days  today 00:00 -> (today+6) 23:59:59.999
 *   custom       dateFrom 00:00 -> dateTo 23:59:59.999 (YYYY-MM-DD, from <= to)
 * Returns null for an unknown range or an invalid/reversed custom pair. */
export function resolveTenantDateWindow(
  range: string,
  timeZone: string | undefined | null,
  dateFrom?: string,
  dateTo?: string,
  now: Date = new Date(),
): (ResolvedDateRange & { timeZone: string }) | null {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const today = todayInTimezone(tz, now);
  let first: { year: number; month0: number; day: number };
  let last: { year: number; month0: number; day: number };

  switch (range) {
    case 'today':
      first = today; last = today;
      break;
    case 'this_week': {
      const dow = new Date(Date.UTC(today.year, today.month0, today.day)).getUTCDay(); // 0=Sun..6=Sat
      first = shiftCalendarDay(today, -((dow + 6) % 7));
      last = shiftCalendarDay(first, 6);
      break;
    }
    case 'this_month': {
      first = { year: today.year, month0: today.month0, day: 1 };
      const lastDay = new Date(Date.UTC(today.year, today.month0 + 1, 0)).getUTCDate();
      last = { year: today.year, month0: today.month0, day: lastDay };
      break;
    }
    case 'last_7_days':
      first = shiftCalendarDay(today, -6); last = today;
      break;
    case 'next_7_days':
      first = today; last = shiftCalendarDay(today, 6);
      break;
    case 'custom': {
      const from = parseIsoCalendarDate(dateFrom);
      const to = parseIsoCalendarDate(dateTo);
      if (!from || !to) return null;
      if (Date.UTC(from.year, from.month0, from.day) > Date.UTC(to.year, to.month0, to.day)) return null;
      first = from; last = to;
      break;
    }
    default:
      return null;
  }
  return { start: startOfLocalDay(first, tz), end: endOfLocalDay(last, tz), timeZone: tz };
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
