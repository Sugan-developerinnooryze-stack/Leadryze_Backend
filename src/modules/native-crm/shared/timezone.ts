/** Shared, dependency-free IANA-timezone math — extracted verbatim from
 * availability.service.ts (where it was previously private/unexported) so
 * other features (date-range.ts's resolveDateRangeForTenant) can reuse the
 * exact same, already-proven wall-clock logic instead of a second,
 * potentially inconsistent implementation. Pure move: same two function
 * bodies, same behavior — availability.service.ts now imports these
 * instead of defining its own copies. */

/** Wall-clock offset (minutes) of `timeZone` at `date` — the standard,
 * dependency-free trick for IANA-timezone math in Node: format the same
 * instant once as UTC and once in the target zone, the wall-clock difference
 * IS the offset (correctly reflecting DST at that specific date). Good
 * enough for a business-hours booking feature; not meant for anything
 * needing sub-minute precision across a DST transition instant itself. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return (tz.getTime() - utc.getTime()) / 60000;
}

/** Builds the correct UTC Date for a given wall-clock date/time as observed
 * in `timeZone` (e.g. "9:00 AM on 2026-08-03 in Asia/Kolkata"). */
export function zonedTimeToUtc(year: number, month0: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naiveUtc = new Date(Date.UTC(year, month0, day, hour, minute));
  const offset = tzOffsetMinutes(naiveUtc, timeZone);
  return new Date(naiveUtc.getTime() - offset * 60000);
}

/** What calendar date is it RIGHT NOW in `timeZone` — e.g. a server at UTC
 * can be on a different date than a tenant in Asia/Kolkata near midnight.
 * `month0` is zero-based (JS Date convention), matching zonedTimeToUtc's
 * own parameter. */
export function todayInTimezone(timeZone: string): { year: number; month0: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month0: get('month') - 1, day: get('day') };
}
