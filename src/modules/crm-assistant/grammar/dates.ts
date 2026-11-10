import type { DateExpr, RelRange, WriteValue } from '../contracts/plan';
import type { FieldNote } from '../writes/workflow-types';
import type { TokenSpan, WordToken } from './tokens';
import {
  CLOCK_WORDS, DATE_BOUND_PHRASES, DATE_BOUND_WORDS, DATE_PREFIXES, DATE_TIME_JOINERS, DAY_AFTER_TOMORROW, MONTH_NAMES,
  OFFSET_UNITS, ORDINAL_SUFFIXES, PAST_WEEKDAY_QUALIFIERS, QUALIFIED_ONLY_WEEKDAYS, REL_RANGE_PHRASES, WEEKDAY_NAMES,
  WEEKDAY_QUALIFIERS,
} from './vocabulary';
import { utcToWallTime } from './wall-time';

/* Date phrases for grammar v1 (Increment 3): "this week", "last 30 days",
 * "in October", "on 5 November", "between 1 and 15 November", "since
 * Monday", "before 1 Dec 2026". A relative phrase becomes a RelRange, which
 * the executor resolves in the tenant's timezone when it runs; a written day
 * becomes { date: 'YYYY-MM-DD' }, worked out here from the tenant-local
 * today (GrammarContext.todayKey). Pure: no clock of its own.
 *
 * Increment 6 adds the date-times a write is given ("tomorrow at 3pm", "next
 * Monday 10:30", "in 2 hours"; matchDateTimeAt at the end). Reads never use
 * them, and nothing above changed for them. */

export type DateValue =
  | { kind: 'within'; rel: RelRange }
  | { kind: 'between'; from: DateExpr; to: DateExpr }
  | { kind: 'bound'; op: 'gt' | 'gte' | 'lt' | 'lte'; at: DateExpr };

export interface DateMatch { length: number; value: DateValue }

export interface DateOptions {
  /** Tenant-local today (YYYY-MM-DD). Without it only relative phrases are read. */
  todayKey?: string;
  /** A past date (when a record was created): a day or month written without
   * a year that is still to come means last year's ("created in November",
   * asked in October). Otherwise the current year is meant ("due in November"). */
  past?: boolean;
}

type Toks = ReadonlyArray<WordToken | undefined>;

/* ── Calendar arithmetic (UTC calendar days; never the server's zone) ──── */

const DAY_MS = 24 * 3600 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** A real calendar day as YYYY-MM-DD, or null (2026-02-30, month 13). */
export function dayKeyOf(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isDayKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return !!m && dayKeyOf(Number(m[1]), Number(m[2]), Number(m[3])) === key;
}

function partsOf(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

export function shiftDays(key: string, days: number): string {
  const { year, month, day } = partsOf(key);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The same day another year; 29 February becomes 28 February. */
export function shiftYears(key: string, years: number): string {
  const { year, month, day } = partsOf(key);
  return dayKeyOf(year + years, month, Math.min(day, daysInMonth(year + years, month))) as string;
}

/** ISO weekday of a day key: Monday 1 ... Sunday 7. */
export function isoWeekdayOf(key: string): number {
  const { year, month, day } = partsOf(key);
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The latest day on or before today that falls on that weekday ("since
 * Monday" on a Monday means today). */
export function weekdayOnOrBefore(todayKey: string, isoWeekday: number): string {
  return shiftDays(todayKey, -((isoWeekdayOf(todayKey) - isoWeekday + 7) % 7));
}

/** First and last day of a month. */
export function monthSpan(year: number, month: number): { from: string; to: string } {
  return { from: dayKeyOf(year, month, 1) as string, to: dayKeyOf(year, month, daysInMonth(year, month)) as string };
}

/* ── Word matchers ─────────────────────────────────────────────────────── */

function wordsAt(toks: Toks, i: number, words: readonly string[]): boolean {
  return words.every((w, k) => toks[i + k]?.w === w);
}

function longest<T extends { length: number }>(found: Array<T | null>): T | null {
  let best: T | null = null;
  for (const f of found) if (f && (!best || f.length > best.length)) best = f;
  return best;
}

/** "this week", "last 30 days", "today": the longest relative phrase at i. */
export function relRangeAt(toks: Toks, i: number): { rel: RelRange; length: number } | null {
  let best: { rel: RelRange; length: number } | null = null;
  for (const p of REL_RANGE_PHRASES) {
    if ((!best || p.words.length > best.length) && wordsAt(toks, i, p.words)) best = { rel: p.rel, length: p.words.length };
  }
  return best;
}

function monthAt(toks: Toks, i: number): number | null {
  const w = toks[i]?.w;
  return w !== undefined && Object.prototype.hasOwnProperty.call(MONTH_NAMES, w) ? MONTH_NAMES[w] : null;
}

/** 1-31, with an optional ordinal ending ("1st", "15 th"). */
function dayNumberAt(toks: Toks, i: number): { day: number; length: number } | null {
  const t = toks[i];
  if (!t || t.num === undefined || t.glued || t.neg || !Number.isInteger(t.num) || t.num < 1 || t.num > 31 || t.w.length > 2) return null;
  const next = toks[i + 1];
  return { day: t.num, length: next && ORDINAL_SUFFIXES.has(next.w) ? 2 : 1 };
}

function yearAt(toks: Toks, i: number): number | null {
  const t = toks[i];
  if (!t || t.num === undefined || t.glued || t.neg || !/^\d{4}$/.test(t.w)) return null;
  return t.num >= 1970 && t.num <= 2100 ? t.num : null;
}

interface DayParts { month: number; day: number; year: number | null; length: number }

/** "5 November", "5th of Nov", "November 5", "Nov 5th 2026" (no ISO). */
function dayMonthAt(toks: Toks, i: number): DayParts | null {
  const found: Array<DayParts | null> = [];
  const d = dayNumberAt(toks, i);
  if (d) {
    let j = i + d.length;
    if (toks[j]?.w === 'of') j += 1;
    const month = monthAt(toks, j);
    if (month !== null) {
      const year = yearAt(toks, j + 1);
      found.push({ month, day: d.day, year, length: j + 1 - i + (year !== null ? 1 : 0) });
    }
  }
  const month = monthAt(toks, i);
  if (month !== null) {
    const d2 = dayNumberAt(toks, i + 1);
    if (d2) {
      const year = yearAt(toks, i + 1 + d2.length);
      found.push({ month, day: d2.day, year, length: 1 + d2.length + (year !== null ? 1 : 0) });
    }
  }
  return longest(found);
}

/** A year-less day is this year's, or last year's for a past date that is
 * still to come. */
function resolveDay(parts: { month: number; day: number; year: number | null }, opts: DateOptions): string | null {
  if (parts.year !== null) return dayKeyOf(parts.year, parts.month, parts.day);
  if (!opts.todayKey || !isDayKey(opts.todayKey)) return null;
  const thisYear = partsOf(opts.todayKey).year;
  const key = dayKeyOf(thisYear, parts.month, parts.day);
  if (!key) return null;
  return opts.past && key > opts.todayKey ? dayKeyOf(thisYear - 1, parts.month, parts.day) : key;
}

/** An explicit day: ISO, or day and month with an optional year. */
function explicitDayAt(toks: Toks, i: number, opts: DateOptions): { key: string; length: number } | null {
  const t = toks[i];
  if (t?.iso) return isDayKey(t.iso) ? { key: t.iso, length: 1 } : null;
  const parts = dayMonthAt(toks, i);
  if (!parts) return null;
  const key = resolveDay(parts, opts);
  return key ? { key, length: parts.length } : null;
}

/** "October", "Oct 2025": the whole month. */
function monthSpanAt(toks: Toks, i: number, opts: DateOptions): { from: string; to: string; length: number } | null {
  const month = monthAt(toks, i);
  if (month === null) return null;
  const year = yearAt(toks, i + 1);
  if (year !== null) return { ...monthSpan(year, month), length: 2 };
  if (!opts.todayKey || !isDayKey(opts.todayKey)) return null;
  const thisYear = partsOf(opts.todayKey).year;
  const span = monthSpan(thisYear, month);
  return { ...(opts.past && span.from > opts.todayKey ? monthSpan(thisYear - 1, month) : span), length: 1 };
}

const between = (from: string, to: string): DateValue => ({ kind: 'between', from: { date: from }, to: { date: to } });

/** "between 1 and 15 November", "between 25 Oct and 5 Nov", "from November
 * 1 to 15", "between March and May". The second part's month (or the
 * first's) fills in what the other leaves out. */
function rangeAt(toks: Toks, i: number, opts: DateOptions): DateMatch | null {
  const intro = toks[i]?.w;
  const joiners = intro === 'between' ? ['and'] : intro === 'from' ? ['to', 'till', 'until', 'through'] : null;
  if (!joiners) return null;
  const a = i + 1;
  const found: Array<DateMatch | null> = [];
  const joinedAt = (j: number) => (toks[j] && joiners.includes(toks[j]!.w) ? j + 1 : -1);

  // Two days, each with its month: "between 25 Oct and 5 Nov", "from 2026-10-01 to 2026-10-15".
  const raw = (j: number): { parts: DayParts | null; iso: string | null; length: number } | null => {
    const t = toks[j];
    if (t?.iso) return isDayKey(t.iso) ? { parts: null, iso: t.iso, length: 1 } : null;
    const parts = dayMonthAt(toks, j);
    return parts ? { parts, iso: null, length: parts.length } : null;
  };
  const first = raw(a);
  if (first) {
    const b = joinedAt(a + first.length);
    if (b > 0) {
      const second = raw(b);
      if (second) found.push(span(first, second, b + second.length - i, opts));
      // "between November 1 and 15": the second day takes the first's month.
      const lone = dayNumberAt(toks, b);
      if (lone && first.parts && toks[a]?.w !== undefined && monthAt(toks, a) !== null) {
        found.push(span(first, { parts: { month: first.parts.month, day: lone.day, year: first.parts.year, length: lone.length }, iso: null }, b + lone.length - i, opts));
      }
    }
  }
  // "between 1 and 15 November": the first day takes the second's month.
  const loneFirst = dayNumberAt(toks, a);
  if (loneFirst) {
    const b = joinedAt(a + loneFirst.length);
    const second = b > 0 ? dayMonthAt(toks, b) : null;
    if (second) {
      found.push(span(
        { parts: { month: second.month, day: loneFirst.day, year: second.year, length: loneFirst.length }, iso: null },
        { parts: second, iso: null },
        b + second.length - i, opts,
      ));
    }
  }
  // "between March and May".
  const m1 = monthAt(toks, a);
  if (m1 !== null) {
    const y1 = yearAt(toks, a + 1);
    const b = joinedAt(a + 1 + (y1 !== null ? 1 : 0));
    const m2 = b > 0 ? monthAt(toks, b) : null;
    if (m2 !== null) {
      const y2 = yearAt(toks, b + 1);
      const length = b + 1 + (y2 !== null ? 1 : 0) - i;
      found.push(span(
        { parts: { month: m1, day: 1, year: y1 ?? y2, length: 1 }, iso: null },
        { parts: { month: m2, day: 0, year: y2 ?? y1, length: 1 }, iso: null },
        length, opts,
      ));
    }
  }
  return longest(found);
}

/** Puts two written days together into an inclusive range. Day 0 means the
 * last day of the month. A year-less range is this year's (its end may fall
 * in the next year: "between 25 Dec and 5 Jan"), or last year's for a past
 * date that is still to come. */
function span(
  a: { parts: DayParts | null; iso: string | null },
  b: { parts: DayParts | null; iso: string | null },
  length: number, opts: DateOptions,
): DateMatch | null {
  const yearOf = (x: typeof a) => (x.iso ? partsOf(x.iso).year : x.parts!.year);
  const given = yearOf(a) ?? yearOf(b);
  let thisYear: number;
  if (given !== null) thisYear = given;
  else if (opts.todayKey && isDayKey(opts.todayKey)) thisYear = partsOf(opts.todayKey).year;
  else return null;
  const keyOf = (x: typeof a, year: number): string | null => {
    if (x.iso) return x.iso;
    const p = x.parts!;
    const y = p.year ?? year;
    return dayKeyOf(y, p.month, p.day === 0 ? daysInMonth(y, p.month) : p.day);
  };
  let from = keyOf(a, yearOf(a) ?? thisYear);
  let to = keyOf(b, yearOf(b) ?? (yearOf(a) ?? thisYear));
  if (!from || !to) return null;
  const yearless = yearOf(a) === null && yearOf(b) === null;
  // "between 25 Dec and 5 Jan" runs into the next year; "between 25 Dec and
  // 5 Jan 2027" starts in the year before the one written. Days written the
  // wrong way round in one month ("between 15 and 1 November") are refused.
  const wraps = !!a.parts && !!b.parts && b.parts.month < a.parts.month;
  if (to < from && yearless && wraps) to = keyOf(b, thisYear + 1);
  else if (to < from && yearOf(a) === null && wraps) from = keyOf(a, (yearOf(b) as number) - 1);
  if (!from || !to || to < from) return null;
  if (yearless && opts.past && opts.todayKey && from > opts.todayKey) {
    from = shiftYears(from, -1);
    to = shiftYears(to, -1);
  }
  return { length, value: between(from, to) };
}

/** The bound word or phrase at i ("since", "until", "up to"), or null. */
function boundWordAt(toks: Toks, i: number): { op: 'gte' | 'gt' | 'lt' | 'lte'; len: number } | null {
  const phrase = DATE_BOUND_PHRASES.find((p) => wordsAt(toks, i, p.words));
  if (phrase) return { op: phrase.op, len: phrase.words.length };
  const w = toks[i]?.w;
  if (w === undefined || !Object.prototype.hasOwnProperty.call(DATE_BOUND_WORDS, w)) return null;
  return { op: DATE_BOUND_WORDS[w], len: 1 };
}

/** "since Monday", "since 1 Oct", "before next week", "after 15 November",
 * "until today", "up to today", "since last month". */
function boundAt(toks: Toks, i: number, opts: DateOptions): DateMatch | null {
  const bound = boundWordAt(toks, i);
  if (!bound) return null;
  const { op, len } = bound;
  const j = i + len;
  const found: Array<DateMatch | null> = [];
  const rel = relRangeAt(toks, j);
  if (rel) found.push({ length: len + rel.length, value: { kind: 'bound', op, at: { rel: rel.rel, edge: op === 'gte' || op === 'lt' ? 'start' : 'end' } } });
  const day = explicitDayAt(toks, j, opts);
  if (day) found.push({ length: len + day.length, value: { kind: 'bound', op, at: { date: day.key } } });
  const month = monthSpanAt(toks, j, opts);
  if (month) found.push({ length: len + month.length, value: { kind: 'bound', op, at: { date: op === 'gte' || op === 'lt' ? month.from : month.to } } });
  const wd = toks[j]?.w;
  if (op === 'gte' && wd !== undefined && Object.prototype.hasOwnProperty.call(WEEKDAY_NAMES, wd) && opts.todayKey && isDayKey(opts.todayKey)) {
    found.push({ length: len + 1, value: { kind: 'bound', op, at: { date: weekdayOnOrBefore(opts.todayKey, WEEKDAY_NAMES[wd]) } } });
  }
  return longest(found);
}

/** [in | on | during | within | for | over the] then a relative range, a
 * month ("in October": a prefix is required, so "may" alone is never May)
 * or a single day ("on 5 November", "5 Nov"). */
function prefixedAt(toks: Toks, i: number, opts: DateOptions): DateMatch | null {
  const found: Array<DateMatch | null> = [];
  const starts: Array<{ at: number; prefixed: boolean }> = [{ at: i, prefixed: false }];
  for (const p of DATE_PREFIXES) if (wordsAt(toks, i, p)) starts.push({ at: i + p.length, prefixed: true });
  for (const s of starts) {
    const lead = s.at - i;
    const rel = relRangeAt(toks, s.at);
    if (rel) found.push({ length: lead + rel.length, value: { kind: 'within', rel: rel.rel } });
    const day = explicitDayAt(toks, s.at, opts);
    if (day) found.push({ length: lead + day.length, value: between(day.key, day.key) });
    if (s.prefixed) {
      const month = monthSpanAt(toks, s.at, opts);
      if (month) found.push({ length: lead + month.length, value: between(month.from, month.to) });
    }
  }
  return longest(found);
}

/** The longest date phrase starting at token i, or null. */
export function matchDateExpr(toks: Toks, i: number, opts: DateOptions = {}): DateMatch | null {
  return longest([rangeAt(toks, i, opts), boundAt(toks, i, opts), prefixedAt(toks, i, opts)]);
}

/* ── Days a condition allows (query/compile.ts resolveRelRange: weeks run
 * Monday to Sunday, "last 7 days" ends today, "next 7 days" starts today) ── */

/** Relative ranges whose first day is never before today, whatever today is. */
const STARTS_TODAY_OR_LATER: ReadonlySet<RelRange> = new Set<RelRange>([
  'today', 'tomorrow', 'next_week', 'next_month', 'next_7_days', 'next_30_days',
]);
/** Relative ranges whose last day is never before today ("this week" ends on Sunday). */
const ENDS_TODAY_OR_LATER: ReadonlySet<RelRange> = new Set<RelRange>([
  ...STARTS_TODAY_OR_LATER, 'this_week', 'this_month', 'this_quarter', 'this_year', 'last_7_days', 'last_30_days',
]);

/** True when a date condition allows no day before today, so a record due
 * before today ("overdue") never meets it: "overdue invoices today", "overdue
 * tasks tomorrow", "next week", "since today", "after yesterday", "due on 5
 * November" asked in October. A written day is compared with todayKey;
 * without one it can't be, and true is returned (the caller refuses). */
export function allowsNoPastDay(value: DateValue, todayKey?: string): boolean {
  // The day `at` names is today or later; after: the day after it is.
  const fromToday = (at: DateExpr, after: boolean): boolean => {
    if ('date' in at) {
      if (!todayKey || !isDayKey(todayKey)) return true;
      return at.date >= (after ? shiftDays(todayKey, -1) : todayKey);
    }
    if (after && at.rel === 'yesterday') return true;
    return (at.edge === 'start' ? STARTS_TODAY_OR_LATER : ENDS_TODAY_OR_LATER).has(at.rel);
  };
  switch (value.kind) {
    case 'within': return STARTS_TODAY_OR_LATER.has(value.rel);
    case 'between': return fromToday(value.from, false) && fromToday(value.to, false);
    default: return value.op === 'gte' ? fromToday(value.at, false) : value.op === 'gt' ? fromToday(value.at, true) : false;
  }
}

/* ── Date-times for writes (Increment 6, spec B8) ──────────────────────────
 * A day and a wall-clock time a write is given (never a query): "tomorrow at
 * 3pm", "3pm tomorrow", "next Monday 10:30", "5 Nov at 4 pm", "in 2 hours".
 * The day and time are the tenant's; the form turns them into an instant in
 * the tenant's timezone (grammar/wall-time.ts, decision U1). Today, now and
 * the timezone are inputs. ":" and "." are no tokens, so a clock time is
 * re-read from what is written between its tokens ("10:30" is not "10 30";
 * "3.30pm" is 15:30, never 3.3). An hour written without am or pm ("at 3")
 * and midnight are read with a note, so the form asks instead of guessing
 * (L14). */

export interface ClockTime { hour: number; minute: number }
export type DateTimeValue =
  | { kind: 'day'; date: string } | { kind: 'day_time'; date: string; time: ClockTime }
  | { kind: 'time'; time: ClockTime } | { kind: 'range'; rel: RelRange };
/** note: an hour from 1 to 11 written without am or pm ("at 3"), or midnight (refused, never written). */
export interface DateTimeMatch { length: number; value: DateTimeValue; note?: 'am_pm' | 'midnight' }
/** tokenizeV1Spans' tokens (a record number as undefined), where each was written, and the text they were read from. */
export interface DateTimeSource { toks: ReadonlyArray<WordToken | undefined>; spans: ReadonlyArray<TokenSpan | null>; text: string }
/** now and timezone: for "in 2 hours". future: a field for a day to come, where a year-less day already
 * past is next year's ("5 Jan" asked in December). */
export interface DateTimeOptions { todayKey: string; now?: Date; timezone?: string; future?: boolean }

type ClockNote = 'am_pm' | 'midnight';
type ClockMatch = { time: ClockTime; length: number; note?: ClockNote };
type DayMatch = { value: Extract<DateTimeValue, { kind: 'day' | 'range' }>; length: number };

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clockMatch = (time: ClockTime, length: number, note?: ClockNote): ClockMatch =>
  (note ? { time, length, note } : { time, length });
const dateTimeMatch = (length: number, value: DateTimeValue, note?: ClockNote): DateTimeMatch =>
  (note ? { length, value, note } : { length, value });
const MINUTE_MS = 60_000;
/** "in N <unit>": at most this many. */
const MAX_OFFSET = 999;
/** today, tomorrow and yesterday are days in a write, not ranges. */
const REL_DAYS: Partial<Record<RelRange, number>> = { today: 0, tomorrow: 1, yesterday: -1 };
const HOUR_AND_MINUTES = /^(\d{1,2})(?:\.(\d{2}))?$/;

/** The token at k as written ("09", "3.30"), or its word where no place is known. */
function writtenAt(src: DateTimeSource, k: number): string {
  const span = src.spans[k];
  return span ? src.text.slice(span[0], span[1]) : src.toks[k]?.w ?? '';
}

/** What is written between tokens k - 1 and k, or null where no place is known. */
function gapBefore(src: DateTimeSource, k: number): string | null {
  const a = src.spans[k - 1];
  const b = src.spans[k];
  return a && b ? src.text.slice(a[1], b[0]) : null;
}

/** "pm", "PM", "p.m." at k. */
function halfOfDayAt(src: DateTimeSource, k: number): { pm: boolean; length: number } | null {
  const w = src.toks[k]?.w;
  if (w === 'am' || w === 'pm') return { pm: w === 'pm', length: 1 };
  if ((w === 'a' || w === 'p') && src.toks[k + 1]?.w === 'm' && gapBefore(src, k + 1) === '.') return { pm: w === 'p', length: 2 };
  return null;
}

/** A clock time at i. bare: right after "at", where a bare hour ("at 3")
 * and a dotted one ("at 3.30") are times too; elsewhere "3" and "3.30" are
 * numbers. */
function clockAt(src: DateTimeSource, i: number, bare: boolean): ClockMatch | null {
  const t = src.toks[i];
  if (!t) return null;
  if (hasOwn(CLOCK_WORDS, t.w)) {
    const time = { ...CLOCK_WORDS[t.w] };
    return clockMatch(time, 1, time.hour === 0 ? 'midnight' : undefined);
  }
  if (t.num === undefined || t.glued || t.neg || t.iso) return null;
  const m = HOUR_AND_MINUTES.exec(writtenAt(src, i));
  if (!m) return null;
  const hour = Number(m[1]);
  let minute = m[2] === undefined ? 0 : Number(m[2]);
  let length = 1;
  // "10:30": the minutes are the next token, two digits written right after a colon.
  const next = src.toks[i + 1];
  const colon = m[2] === undefined && next?.num !== undefined && !next.glued
    && gapBefore(src, i + 1) === ':' && /^\d{2}$/.test(writtenAt(src, i + 1));
  if (colon) {
    minute = Number(writtenAt(src, i + 1));
    length = 2;
  }
  if (minute > 59) return null;
  const half = halfOfDayAt(src, i + length);
  if (half) {
    if (hour < 1 || hour > 12) return null;
    const time = { hour: (hour % 12) + (half.pm ? 12 : 0), minute };
    return clockMatch(time, length + half.length, time.hour === 0 && minute === 0 ? 'midnight' : undefined);
  }
  // Other letters against the number ("at 3rd floor"), or a number that is no time.
  if (src.toks[i + length]?.glued || (!colon && !bare) || hour > 23) return null;
  const time = { hour, minute };
  if (hour === 0 && minute === 0) return clockMatch(time, length, 'midnight');
  // 12 to 23, or a leading zero ("09:00"): as written. 1 to 11: which half of the day?
  return clockMatch(time, length, hour >= 12 || m[1].startsWith('0') ? undefined : 'am_pm');
}

/** A clock time at i: "3pm", "3 p.m.", "3:30pm", "3.30pm" (15:30), "15:30",
 * "09:00", "noon", "midday"; "3:30" and "10:30" with note am_pm; "midnight",
 * "12am" and "00:00" with note midnight. A bare hour ("3") is read only after
 * "at" (matchDateTimeAt). */
export function clockTimeAt(src: DateTimeSource, i: number): { time: ClockTime; length: number; note?: 'am_pm' | 'midnight' } | null {
  return clockAt(src, i, false);
}

/** "Friday" or "this Friday": the next Friday after today (asked on a
 * Friday, a week on); "next Friday" or "Friday next week": the Friday of next
 * Monday-to-Sunday week, the weeks of next_week; "last", "past" or "previous
 * Friday": the latest Friday before today (L31). Monday asked on a Monday is
 * a week on, or for "last Monday" a week back. */
export function weekdayDayAt(toks: Toks, i: number, todayKey: string): { date: string; length: number } | null {
  if (!isDayKey(todayKey)) return null;
  const q = toks[i]?.w;
  const past = q !== undefined && PAST_WEEKDAY_QUALIFIERS.has(q);
  const qualified = past || (q !== undefined && WEEKDAY_QUALIFIERS.has(q));
  const w = toks[qualified ? i + 1 : i]?.w;
  if (w === undefined || !hasOwn(WEEKDAY_NAMES, w) || (!qualified && QUALIFIED_ONLY_WEEKDAYS.has(w))) return null;
  const day = WEEKDAY_NAMES[w];
  const today = isoWeekdayOf(todayKey);
  if (past) return { date: shiftDays(todayKey, -((today - day + 7) % 7 || 7)), length: 2 };
  // "Friday next week" (or "coming week") is read whole, as "next Friday".
  const week = qualified ? null : relRangeAt(toks, i + 1);
  const nextWeek = week?.rel === 'next_week' ? week.length : 0;
  const ahead = q === 'next' || nextWeek > 0 ? 7 - today + day : (day - today + 7) % 7 || 7;
  return { date: shiftDays(todayKey, ahead), length: qualified ? 2 : 1 + nextWeek };
}

/** An ISO day, or a written one ("5 Nov", "November 5th 2026"). Year-less:
 * this year's, or with `future` next year's once this year's has passed. */
function writtenDayAt(toks: Toks, i: number, opts: DateTimeOptions): { date: string; length: number } | null {
  const t = toks[i];
  if (t?.iso) return isDayKey(t.iso) ? { date: t.iso, length: 1 } : null;
  const parts = dayMonthAt(toks, i);
  if (!parts) return null;
  const thisYear = partsOf(opts.todayKey).year;
  const key = dayKeyOf(parts.year ?? thisYear, parts.month, parts.day);
  const date = parts.year === null && opts.future && (!key || key < opts.todayKey)
    ? dayKeyOf(thisYear + 1, parts.month, parts.day) : key;
  return date ? { date, length: parts.length } : null;
}

/** A day at i ("today", "day after tomorrow", "Friday", "next Friday", "last
 * Friday", "5 Nov", "2026-11-05"), or a range that names no one day ("this
 * week"). */
function dayAt(toks: Toks, i: number, opts: DateTimeOptions): DayMatch | null {
  if (!isDayKey(opts.todayKey)) return null;
  const day = (date: string, length: number): DayMatch => ({ value: { kind: 'day', date }, length });
  const found: Array<DayMatch | null> = [];
  if (wordsAt(toks, i, DAY_AFTER_TOMORROW)) found.push(day(shiftDays(opts.todayKey, 2), DAY_AFTER_TOMORROW.length));
  const rel = relRangeAt(toks, i);
  const shift = rel ? REL_DAYS[rel.rel] : undefined;
  if (rel) found.push(shift === undefined ? { value: { kind: 'range', rel: rel.rel }, length: rel.length } : day(shiftDays(opts.todayKey, shift), rel.length));
  const weekday = weekdayDayAt(toks, i, opts.todayKey);
  if (weekday) found.push(day(weekday.date, weekday.length));
  const written = writtenDayAt(toks, i, opts);
  if (written) found.push(day(written.date, written.length));
  return longest(found);
}

/** "in 2 hours", "in 30 mins", "in an hour": that time from now, in the
 * tenant's timezone; "in 3 days", "in a week": that day. */
function offsetAt(src: DateTimeSource, i: number, opts: DateTimeOptions): DateTimeMatch | null {
  if (src.toks[i]?.w !== 'in') return null;
  const n = src.toks[i + 1];
  const count = n?.w === 'a' || n?.w === 'an' ? 1
    : n?.num !== undefined && !n.glued && !n.neg && Number.isInteger(n.num) && n.num >= 1 && n.num <= MAX_OFFSET ? n.num : null;
  const unit = src.toks[i + 2]?.w;
  if (count === null || unit === undefined || !hasOwn(OFFSET_UNITS, unit)) return null;
  const per = OFFSET_UNITS[unit];
  if (per === 'day' || per === 'week') {
    return isDayKey(opts.todayKey) ? { length: 3, value: { kind: 'day', date: shiftDays(opts.todayKey, count * (per === 'week' ? 7 : 1)) } } : null;
  }
  const from = opts.now?.getTime();
  if (from === undefined || !Number.isFinite(from) || !opts.timezone) return null;
  const wall = utcToWallTime(new Date(from + count * (per === 'hour' ? 60 : 1) * MINUTE_MS), opts.timezone);
  const [hour, minute] = wall.time.split(':').map(Number);
  return dateTimeMatch(3, { kind: 'day_time', date: wall.date, time: { hour, minute } }, hour === 0 && minute === 0 ? 'midnight' : undefined);
}

/** The time right after a day: "3pm", "at 3pm", "by 5pm", "at 3" (a bare hour after "at"). */
function timeAfterDay(src: DateTimeSource, k: number): ClockMatch | null {
  const w = src.toks[k]?.w;
  if (w !== 'at' && w !== 'by') return clockAt(src, k, false);
  const clock = clockAt(src, k + 1, w === 'at');
  return clock ? { ...clock, length: clock.length + 1 } : null;
}

/** The longest date-time phrase at token i, or null: a day, then perhaps its
 * time ("tomorrow at 3pm", "on 5 Nov at 4 pm"); a time, then perhaps its day
 * ("3pm tomorrow", "at 3 on Monday"); a time from now ("in 2 hours"); or a
 * range ("this week": no one day). "at", "on" or "by" may come first. Year-
 * less days follow `future`. "morning", "afternoon" and "evening" are no
 * times. */
export function matchDateTimeAt(src: DateTimeSource, i: number, opts: DateTimeOptions): DateTimeMatch | null {
  const found: Array<DateTimeMatch | null> = [offsetAt(src, i, opts)];
  const joiner = src.toks[i]?.w;
  const j = joiner !== undefined && DATE_TIME_JOINERS.has(joiner) ? i + 1 : i;
  const day = dayAt(src.toks, j, opts);
  if (day) {
    const k = j + day.length;
    found.push({ length: k - i, value: day.value });
    const time = day.value.kind === 'day' ? timeAfterDay(src, k) : null;
    if (time && day.value.kind === 'day') {
      found.push(dateTimeMatch(k + time.length - i, { kind: 'day_time', date: day.value.date, time: time.time }, time.note));
    }
  }
  const clock = clockAt(src, j, j > i && joiner === 'at');
  if (clock) {
    const k = j + clock.length;
    found.push(dateTimeMatch(k - i, { kind: 'time', time: clock.time }, clock.note));
    const on = src.toks[k]?.w === 'on' ? 1 : 0;
    const then = dayAt(src.toks, k + on, opts);
    if (then && then.value.kind === 'day') {
      found.push(dateTimeMatch(k + on + then.length - i, { kind: 'day_time', date: then.value.date, time: clock.time }, clock.note));
    }
  }
  return longest(found);
}

const clockText = (t: ClockTime): string => `${pad(t.hour)}:${pad(t.minute)}`;

/** The value a date or datetime field takes from a date-time read from words
 * (spec B8), and the note when it can't take all of it: a datetime given only
 * a day needs a time (add_time); a date given a time keeps the day
 * (time_dropped); a time alone or a range names no day (which_day). */
export function toWriteDate(value: DateTimeValue, kind: 'date' | 'datetime'): { value?: WriteValue; note?: FieldNote } {
  if (value.kind === 'day') return kind === 'date' ? { value: { date: value.date } } : { value: { date: value.date }, note: 'add_time' };
  if (value.kind === 'day_time') {
    return kind === 'date' ? { value: { date: value.date }, note: 'time_dropped' } : { value: { date: value.date, time: clockText(value.time) } };
  }
  return { note: 'which_day' };
}
