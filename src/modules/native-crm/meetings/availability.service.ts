import mongoose from 'mongoose';
import { Meeting } from './meeting.model';
import { Tenant } from '../../tenants/tenant.model';

export interface AvailableSlot {
  startIso: string;
  endIso: string;
  label: string;
}

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock offset (minutes) of `timeZone` at `date` — the standard,
 * dependency-free trick for IANA-timezone math in Node: format the same
 * instant once as UTC and once in the target zone, the wall-clock difference
 * IS the offset (correctly reflecting DST at that specific date). Good
 * enough for a business-hours booking feature; not meant for anything
 * needing sub-minute precision across a DST transition instant itself. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return (tz.getTime() - utc.getTime()) / 60000;
}

/** Builds the correct UTC Date for a given wall-clock date/time as observed
 * in `timeZone` (e.g. "9:00 AM on 2026-08-03 in Asia/Kolkata"). */
function zonedTimeToUtc(year: number, month0: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naiveUtc = new Date(Date.UTC(year, month0, day, hour, minute));
  const offset = tzOffsetMinutes(naiveUtc, timeZone);
  return new Date(naiveUtc.getTime() - offset * 60000);
}

function localDateParts(date: Date, timeZone: string): { year: number; month0: number; day: number; weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month0: Number(get('month')) - 1,
    day: Number(get('day')),
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
    hour: Number(get('hour')) % 24,
  };
}

function formatLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

/** Tenant-wide business-hours availability — no per-staff calendars exist in
 * this codebase, so this is deliberately single-capacity: any scheduled
 * Meeting occupying a time range makes that whole range unavailable,
 * regardless of who it's assigned to. Round-robin still decides WHICH staff
 * member gets assigned once a slot is booked (see bookWidgetMeeting) — this
 * doesn't add a second, competing assignment concept. */
export async function computeAvailableSlots(
  tenantId: string,
  opts: { fromIso?: string; days?: number; timeOfDay?: 'morning' | 'afternoon' | 'any'; limit?: number } = {}
): Promise<AvailableSlot[]> {
  const tenant = await Tenant.findById(tenantId).select('widget.booking').lean();
  const booking = tenant?.widget?.booking;
  if (!booking?.enabled || !booking.hours?.length) return [];

  const tz = booking.timezone || 'UTC';
  const limit = Math.min(opts.limit ?? 10, 50);
  const now = new Date();
  const earliest = opts.fromIso ? new Date(opts.fromIso) : now;
  const leadTimeFloor = new Date(now.getTime() + booking.leadTimeHours * 3600_000);
  const windowStart = earliest > leadTimeFloor ? earliest : leadTimeFloor;
  const scanDays = Math.min(opts.days ?? booking.horizonDays, booking.horizonDays);
  const windowEnd = new Date(now.getTime() + booking.horizonDays * 86_400_000);

  // Pull every scheduled meeting inside the whole scan window ONCE, filter
  // candidate slots against it in memory — cheaper than one query per slot.
  const existing = await Meeting.find({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    meetingStatus: 'scheduled',
    startDate: { $lt: windowEnd },
    endDate: { $gt: windowStart },
  }).select('startDate endDate').lean();

  const overlaps = (start: Date, end: Date) =>
    existing.some((m) => m.startDate && m.endDate && start < m.endDate && end > m.startDate);

  const results: AvailableSlot[] = [];
  for (let dayOffset = 0; dayOffset <= scanDays && results.length < limit; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86_400_000);
    const { year, month0, day, weekday } = localDateParts(probe, tz);
    const dayHours = booking.hours.filter((h: any) => h.day === weekday);

    for (const h of dayHours) {
      const [startH, startM] = h.start.split(':').map(Number);
      const [endH, endM] = h.end.split(':').map(Number);
      let slotStart = zonedTimeToUtc(year, month0, day, startH, startM, tz);
      const dayEnd = zonedTimeToUtc(year, month0, day, endH, endM, tz);

      while (slotStart.getTime() + booking.slotMinutes * 60_000 <= dayEnd.getTime() && results.length < limit) {
        const slotEnd = new Date(slotStart.getTime() + booking.slotMinutes * 60_000);

        if (slotStart >= windowStart && slotStart <= windowEnd && !overlaps(slotStart, slotEnd)) {
          const localHour = localDateParts(slotStart, tz).hour;
          const matchesTimeOfDay =
            !opts.timeOfDay || opts.timeOfDay === 'any' ||
            (opts.timeOfDay === 'morning' ? localHour < 12 : localHour >= 12);
          if (matchesTimeOfDay) {
            results.push({ startIso: slotStart.toISOString(), endIso: slotEnd.toISOString(), label: formatLabel(slotStart, tz) });
          }
        }
        slotStart = slotEnd;
      }
    }
  }

  return results;
}

/** Re-check used right before actually booking — same overlap logic as
 * computeAvailableSlots, scoped to one candidate range instead of scanning a
 * whole window. Deliberately tenant-wide (no staffId filter by default,
 * matching the single-capacity model above) — the optional staffId param
 * exists for a future per-staff model, unused by bookWidgetMeeting today. */
export async function isSlotFree(tenantId: string, startIso: string, endIso: string, staffId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
    meetingStatus: 'scheduled',
    startDate: { $lt: new Date(endIso) },
    endDate: { $gt: new Date(startIso) },
  };
  if (staffId) filter.assignedStaffId = staffId;
  const conflict = await Meeting.exists(filter);
  return !conflict;
}
