import { isValidTimeZone } from '../../native-crm/shared/date-range';

/* A tenant wall time ("2026-11-02 15:00 in Asia/Kolkata") to the instant it
 * names, and back, DST-safe and independent of the server's own zone
 * (decision U1; Date.UTC and Intl only). NC/shared/timezone.ts's
 * zonedTimeToUtc takes the zone's offset once, at the wall time read as if
 * it were UTC, and is an hour out around a clock change; the screens that
 * use it keep it unchanged. Here the instants the zone's offsets a day
 * either side would give are formatted back, and the ones that show the
 * wall time asked for are kept: one is exact; two (the clocks went back)
 * take the earlier; none (the clocks went forward) moves the wall time
 * forward by the gap, as the screens' pickers do. */

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number }

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const pad = (n: number) => String(n).padStart(2, '0');

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock `timeZone` shows at `at`. */
function zoneParts(at: Date, timeZone: string): ZoneParts {
  const parts = formatterFor(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // hourCycle h23 shows midnight as 00; a runtime that still says 24 is read the same.
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** The zone's offset from UTC at `at`, in minutes (east positive). */
function offsetAt(at: Date, timeZone: string): number {
  const p = zoneParts(at, timeZone);
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((shown - at.getTime()) / MINUTE_MS);
}

const sameWall = (p: ZoneParts, w: WallTime): boolean =>
  p.year === w.year && p.month === w.month && p.day === w.day && p.hour === w.hour && p.minute === w.minute;

/** The instant at which `timeZone` shows this wall time. `adjusted` says
 * whether the wall time happened once (exact), twice (overlap: the earlier
 * instant) or not at all (gap: the wall time moved forward by the gap, so
 * 02:30 in a skipped hour becomes 03:30). An unknown zone reads as UTC. */
export function wallTimeToUtc(p: WallTime, timeZone: string): { at: Date; adjusted: 'exact' | 'gap' | 'overlap' } {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetBefore = offsetAt(new Date(naive - DAY_MS), zone);
  const offsets = new Set([offsetBefore, offsetAt(new Date(naive), zone), offsetAt(new Date(naive + DAY_MS), zone)]);
  const kept = [...offsets]
    .map((offset) => naive - offset * MINUTE_MS)
    .filter((ms) => sameWall(zoneParts(new Date(ms), zone), p))
    .sort((a, b) => a - b);
  if (kept.length === 1) return { at: new Date(kept[0]), adjusted: 'exact' };
  if (kept.length > 1) return { at: new Date(kept[0]), adjusted: 'overlap' };
  return { at: new Date(naive - offsetBefore * MINUTE_MS), adjusted: 'gap' };
}

/** The wall time `timeZone` shows at `at`, as a form holds it: 'YYYY-MM-DD' and 'HH:mm'. An unknown zone reads as UTC. */
export function utcToWallTime(at: Date, timeZone: string): { date: string; time: string } {
  const p = zoneParts(at, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}
