import { isValidTimeZone } from '../native-crm/shared/date-range';
import { todayInTimezone } from '../native-crm/shared/timezone';
import { DailyEventBucket } from './daily-events.types';

/** "Upcoming" covers the 7 calendar days after today. */
export const UPCOMING_DAYS = 7;
export const DAY_MS = 24 * 3600 * 1000;

/** The server's own zone: the zone the contract schedule engine and the
 * work order module use for their date-only "midnight" values
 * (schedule.engine.ts dateOnly, workorder.service.ts isDateOnly). */
export const SERVER_TIMEZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/** How a stored date is turned into a calendar day:
 *  - 'instant': a real moment (meeting start, ticket SLA) — the tenant-local
 *    date and time.
 *  - 'instantOrMidnight': a moment, except that exactly midnight in the
 *    server's zone is a date-only, all-day value — the work order module's
 *    own rule (isDateOnly), also used for call dates written as plain dates.
 *  - 'date': a date-only field (due date, close date…). UTC midnight (from a
 *    YYYY-MM-DD picker) or server midnight keep their own calendar date; any
 *    other instant (e.g. a browser-local midnight) is read as its
 *    tenant-local date. Always all-day. */
export type DateRule = 'instant' | 'instantOrMidnight' | 'date';

/** Today and the upcoming range for one request, as tenant-local calendar
 * dates. Days are matched on calendar dates (not instant windows), so
 * daylight-saving changes need no special handling. */
export interface DayWindows {
  timezone: string;
  timezoneFallback: boolean;
  now: Date;
  todayKey: string;
  upcomingEndKey: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function keyOf(year: number, month0: number, day: number): string {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

/** UTC midnight of a YYYY-MM-DD calendar date. */
export function keyStartUtc(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDaysToKey(key: string, days: number): string {
  return new Date(keyStartUtc(key).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function buildDayWindows(timeZone: string | null | undefined, now: Date = new Date()): DayWindows {
  const timezoneFallback = !isValidTimeZone(timeZone);
  const tz = timezoneFallback ? 'UTC' : (timeZone as string);
  const t = todayInTimezone(tz, now);
  const todayKey = keyOf(t.year, t.month0, t.day);
  return { timezone: tz, timezoneFallback, now, todayKey, upcomingEndKey: addDaysToKey(todayKey, UPCOMING_DAYS) };
}

/* Intl formatters are costly to build; one per zone is reused. */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, f);
  }
  return f;
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = timeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(timeZone, f);
  }
  return f;
}

/** YYYY-MM-DD of an instant as seen in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** HH:mm (24h) of an instant as seen in `timeZone`. */
export function localTime(date: Date, timeZone: string): string {
  const parts = timeFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function serverLocalDateKey(date: Date): string {
  return keyOf(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isUtcMidnight(date: Date): boolean {
  return date.getTime() % DAY_MS === 0;
}

export function isServerMidnight(date: Date): boolean {
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

/** The calendar day a stored date belongs to under `rule` — the JavaScript
 * twin of the database expression the service queries with
 * (dayKeyExpression), used for connector data and contract visits. */
export function dayKeyFor(date: Date, rule: DateRule, timeZone: string): { key: string; allDay: boolean } {
  if (rule === 'date') {
    if (isUtcMidnight(date)) return { key: utcDateKey(date), allDay: true };
    if (isServerMidnight(date)) return { key: serverLocalDateKey(date), allDay: true };
    return { key: localDateKey(date, timeZone), allDay: true };
  }
  if (rule === 'instantOrMidnight' && isServerMidnight(date)) return { key: serverLocalDateKey(date), allDay: true };
  return { key: localDateKey(date, timeZone), allDay: false };
}

/** Which section a calendar date belongs to, or null if outside all of them. */
export function bucketForKey(key: string, windows: Pick<DayWindows, 'todayKey' | 'upcomingEndKey'>): DailyEventBucket | null {
  if (key === windows.todayKey) return 'today';
  if (key < windows.todayKey) return 'overdue';
  if (key <= windows.upcomingEndKey) return 'upcoming';
  return null;
}
