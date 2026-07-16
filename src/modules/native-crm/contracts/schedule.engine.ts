/**
 * Contract Schedule Engine — expands per-service schedule rules into a list
 * of dated visits across the contract period. Pure functions, no DB access.
 *
 * Rules are calendar-accurate: "monthly" means the same day next month
 * (clamped to month end), never a hardcoded 30-day stride.
 */
import { IContractServiceLine, IContractVisit, IScheduleRule } from './contract.model';

const MAX_VISITS = 1000;
const DAY_MS = 24 * 3600 * 1000;

/* ── date helpers (all local-time, date-only precision) ────────────────────── */

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Same day N months later, clamped to the target month's end. */
function addMonthsClamped(d: Date, n: number, anchorDay: number | 'last'): Date {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const last = lastDayOfMonth(targetY, targetM);
  const day = anchorDay === 'last' ? last : Math.min(anchorDay, last);
  return new Date(targetY, targetM, day);
}

function inRange(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function keyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ── rule expansion ────────────────────────────────────────────────────────── */

const MONTH_STEP: Record<string, number> = {
  monthly: 1, bimonthly: 2, quarterly: 3, halfyearly: 6, yearly: 12,
};

/** Expand one schedule rule into all dates within [start, end] inclusive. */
export function expandRule(rule: IScheduleRule, start: Date, end: Date): Date[] {
  const s = dateOnly(start);
  const e = dateOnly(end);
  if (e.getTime() < s.getTime()) return [];
  const dates: Date[] = [];

  switch (rule.frequency) {
    case 'once':
      dates.push(s);
      break;

    case 'daily': {
      for (let d = new Date(s); inRange(d, s, e) && dates.length <= MAX_VISITS; d = addDays(d, 1)) {
        dates.push(new Date(d));
      }
      break;
    }

    case 'weekly':
    case 'fortnightly': {
      const stepWeeks = rule.frequency === 'weekly' ? 1 : 2;
      const weekdays = rule.weekdays?.length ? rule.weekdays : [s.getDay()];
      for (const wd of weekdays) {
        // first occurrence of this weekday on/after start
        const diff = (wd - s.getDay() + 7) % 7;
        for (let d = addDays(s, diff); inRange(d, s, e) && dates.length <= MAX_VISITS; d = addDays(d, stepWeeks * 7)) {
          dates.push(new Date(d));
        }
      }
      break;
    }

    case 'monthly':
    case 'bimonthly':
    case 'quarterly':
    case 'halfyearly':
    case 'yearly': {
      const step = MONTH_STEP[rule.frequency];
      const anchor: number | 'last' = rule.dayOfMonth ?? s.getDate();
      // anchor months restrict which calendar months are eligible (1-12)
      const monthsFilter = rule.months?.length ? new Set(rule.months) : null;
      for (let i = 0; dates.length <= MAX_VISITS; i++) {
        const d = addMonthsClamped(s, i * step, anchor);
        if (d.getTime() > e.getTime()) break;
        if (d.getTime() < s.getTime()) continue;
        if (monthsFilter && !monthsFilter.has(d.getMonth() + 1)) continue;
        dates.push(d);
      }
      break;
    }

    case 'custom_interval': {
      const n = rule.everyNDays && rule.everyNDays >= 1 ? rule.everyNDays : 1;
      for (let d = new Date(s); inRange(d, s, e) && dates.length <= MAX_VISITS; d = addDays(d, n)) {
        dates.push(new Date(d));
      }
      break;
    }

    case 'custom_dates': {
      for (const iso of rule.dates ?? []) {
        const d = dateOnly(new Date(iso));
        if (!isNaN(d.getTime()) && inRange(d, s, e)) dates.push(d);
      }
      dates.sort((a, b) => a.getTime() - b.getTime());
      break;
    }
  }

  return dates;
}

/* ── visit generation ──────────────────────────────────────────────────────── */

function lineNet(line: IContractServiceLine): number {
  const gross = (Number(line.amount) || 0) * (Number(line.count) || 1);
  const afterDiscount = gross * (1 - (Number(line.discountPercent) || 0) / 100);
  const withTax = afterDiscount * (1 + (Number(line.taxPercent) || 0) / 100);
  return Math.round(withTax * 100) / 100;
}

/**
 * Generate the full visit schedule for a contract.
 * Lines landing on the same date are merged into one visit.
 */
export function generateVisits(
  lines: IContractServiceLine[],
  startDate: Date | string,
  endDate: Date | string,
): IContractVisit[] {
  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];

  // date key → merged visit accumulator
  const byDate = new Map<string, { date: Date; services: IContractVisit['services']; amount: number }>();
  let produced = 0;

  for (const line of lines) {
    if (!line?.scheduleRule?.frequency) continue;
    const dates = expandRule(line.scheduleRule, start, end);
    for (const d of dates) {
      produced++;
      if (produced > MAX_VISITS) {
        throw new Error(`Schedule too large: more than ${MAX_VISITS} visits would be generated. Shorten the period or reduce frequency.`);
      }
      const key = keyOf(d);
      let entry = byDate.get(key);
      if (!entry) {
        entry = { date: d, services: [], amount: 0 };
        byDate.set(key, entry);
      }
      entry.services.push({
        name:          line.name,
        amount:        Number(line.amount) || 0,
        count:         Number(line.count) || 1,
        durationHours: line.durationHours,
        serviceId:     line.serviceId,
        frequency:     line.scheduleRule.frequency,
      });
      entry.amount = Math.round((entry.amount + lineNet(line)) * 100) / 100;
    }
  }

  return [...byDate.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((v, i) => ({
      visitNumber: i + 1,
      serviceDate: v.date,
      services:    v.services,
      amount:      v.amount,
      status:      'planned' as const,
    }));
}

/* ── summary (schedule preview) ────────────────────────────────────────────── */

export interface ScheduleSummary {
  totalVisits:      number;
  totalDays:        number;
  perMonth:         { month: string; count: number }[];   // "2026-07" → count
  estimatedRevenue: number;
  estimatedHours:   number;
}

export function summarizeVisits(
  visits: IContractVisit[],
  startDate?: Date | string,
  endDate?: Date | string,
): ScheduleSummary {
  const perMonthMap = new Map<string, number>();
  let revenue = 0;
  let hours = 0;

  for (const v of visits) {
    const d = new Date(v.serviceDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    perMonthMap.set(key, (perMonthMap.get(key) ?? 0) + 1);
    revenue += Number(v.amount) || 0;
    for (const s of v.services) hours += Number(s.durationHours) || 0;
  }

  let totalDays = 0;
  if (startDate && endDate) {
    const s = dateOnly(new Date(startDate));
    const e = dateOnly(new Date(endDate));
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e >= s) {
      totalDays = Math.floor((e.getTime() - s.getTime()) / DAY_MS) + 1;
    }
  }

  return {
    totalVisits:      visits.length,
    totalDays,
    perMonth:         [...perMonthMap.entries()].sort().map(([month, count]) => ({ month, count })),
    estimatedRevenue: Math.round(revenue * 100) / 100,
    estimatedHours:   Math.round(hours * 100) / 100,
  };
}

/* ── derived balance ───────────────────────────────────────────────────────── */

export interface ServiceBalance {
  total:     number;
  completed: number;
  upcoming:  number;   // planned, today or future
  overdue:   number;   // planned, past
  scheduled: number;   // WO created, not yet completed
  cancelled: number;
  remaining: number;   // planned + scheduled
}

export function computeBalance(visits?: IContractVisit[] | null): ServiceBalance | null {
  if (!visits?.length) return null;
  const today = dateOnly(new Date()).getTime();
  const b: ServiceBalance = { total: visits.length, completed: 0, upcoming: 0, overdue: 0, scheduled: 0, cancelled: 0, remaining: 0 };
  for (const v of visits) {
    switch (v.status) {
      case 'completed': b.completed++; break;
      case 'cancelled': b.cancelled++; break;
      case 'scheduled': b.scheduled++; b.remaining++; break;
      default: {
        b.remaining++;
        if (dateOnly(new Date(v.serviceDate)).getTime() < today) b.overdue++;
        else b.upcoming++;
      }
    }
  }
  return b;
}

/** Human summary of the frequencies used, e.g. "Daily, Weekly" — for the list column. */
export function serviceRangeSummary(lines?: IContractServiceLine[] | null): string {
  if (!lines?.length) return '';
  const LABELS: Record<string, string> = {
    once: 'Once', daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly',
    monthly: 'Monthly', bimonthly: 'Bi-Monthly', quarterly: 'Quarterly',
    halfyearly: 'Half-Yearly', yearly: 'Yearly',
    custom_interval: 'Custom', custom_dates: 'Custom Dates',
  };
  const seen: string[] = [];
  for (const l of lines) {
    const f = l.scheduleRule?.frequency;
    if (!f) continue;
    const label = f === 'custom_interval' && l.scheduleRule?.everyNDays
      ? `Every ${l.scheduleRule.everyNDays} days`
      : (LABELS[f] ?? f);
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(', ');
}
