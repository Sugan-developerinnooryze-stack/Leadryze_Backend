import mongoose from 'mongoose';
import { NativeWorkorder } from '../../native-crm/workorders/workorder.model';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { isValidTimeZone } from '../../native-crm/shared/date-range';
import { addDaysToKey, dayKeyFor } from '../../daily-events/daily-events.time';
import { utcToWallTime, wallTimeToUtc } from '../grammar/wall-time';

/* A read-only port of the work order service's checkStaffAvailability for
 * the guided form (Increment 6, B-WO; L5, L17): the original writes
 * PipelineConfig through getOutcomeStageKey and reads the server's zone,
 * so the form asks this one instead, in the tenant's zone, and never names
 * the clashing work order.
 *
 * The rules are the original's. A work order with no duration (its own,
 * else the organization's Field Service default) or stored as a date-only
 * value (midnight in the server's zone, read with dayKeyFor
 * 'instantOrMidnight' as Daily Events reads it) makes its staff busy all
 * that day. Any other occupies [S, S + D] and blocks a new start in
 * [S - D, S + 2D). Days are the tenant's, never the server's (L17).
 *
 * One query covers every staff member asked about. Like the original it is
 * tenant-wide (no branch, no data scope: a staff member is busy whoever
 * booked them), so the answer holds times only, never a work order's id,
 * number or title. Cancelled work orders don't count: the pipeline's active
 * stage tagged 'cancelled' (else 'cancelled'), read with peekStages, which
 * never seeds a pipeline. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The availability read never holds a form step up for longer than this. */
const QUERY_MAX_TIME_MS = 3000;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export interface StaffConflict { busy: boolean; allDay: boolean; availableAfter?: Date; availableBefore?: Date }

/** The fields the query reads: never a number or a title. */
interface BookedWorkorder { staffId?: string | null; staffIds?: string[] | null; scheduledDate?: Date | string | null; durationHours?: number | null }

/** One staff member's clash, in epoch ms until the answer is built. */
type Clash = { allDay: true; after: number } | { allDay: false; after: number; before: number };

/** The instant a tenant-local day ('YYYY-MM-DD') starts in `timeZone`. */
function dayStartAt(dayKey: string, timeZone: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  return wallTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone).at.getTime();
}

/** Two clashes for one staff member: busy all day wins, else the widest blocked window. */
function widest(a: Clash, b: Clash): Clash {
  if (a.allDay) return a;
  if (b.allDay) return b;
  return { allDay: false, after: Math.max(a.after, b.after), before: Math.min(a.before, b.before) };
}

function conflictOf(clash: Clash | undefined): StaffConflict {
  if (!clash) return { busy: false, allDay: false };
  return clash.allDay
    ? { busy: true, allDay: true, availableAfter: new Date(clash.after) }
    : { busy: true, allDay: false, availableAfter: new Date(clash.after), availableBefore: new Date(clash.before) };
}

/** Each chosen staff member's clash with their other work orders around `at`, by staff key. Every key
 * asked about is answered (busy false when free). `excludeId` is the work order being changed; `now`
 * is accepted for the callers' clock, the answer depends only on `at`. Reads only: peekStages,
 * getSettings and one find. */
export async function findStaffConflicts(input: { tenantId: string; timezone: string; staffIds: readonly string[]; at: Date;
  excludeId?: string; now?: Date }): Promise<Map<string, StaffConflict>> {
  const keys = [...new Set(input.staffIds.map((key) => String(key ?? '').trim()).filter(Boolean))];
  const clashes = new Map<string, Clash>();
  const answer = () => new Map(keys.map((key): [string, StaffConflict] => [key, conflictOf(clashes.get(key))]));
  const at = input.at.getTime();
  if (!keys.length || !Number.isFinite(at)) return answer();

  const timeZone = isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
  const dayKey = utcToWallTime(input.at, timeZone).date;
  const dayStart = dayStartAt(dayKey, timeZone);
  const nextDayStart = dayStartAt(addDaysToKey(dayKey, 1), timeZone);

  const [stages, settings] = await Promise.all([
    peekStages(input.tenantId, 'workorder'),
    // The original's fallback duration: the organization's settings, never a branch's.
    getSettings(input.tenantId, null).catch(() => null),
  ]);
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  const cancelledKey = stages.find((s) => s.outcome === 'cancelled' && s.isActive !== false)?.key ?? 'cancelled';
  const orgHours = Number(settings?.defaultDurationHours);
  const defaultHours = Number.isFinite(orgHours) && orgHours > 0 ? orgHours : null;

  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(input.tenantId),
    $or: [{ staffId: { $in: keys } }, { staffIds: { $in: keys } }],
    // The tenant's day widened by 24 hours on each side, as the original
    // widens its own, so a blocked window crossing midnight is still found.
    scheduledDate: { $gte: new Date(dayStart - DAY_MS), $lte: new Date(nextDayStart - 1 + DAY_MS) },
    status: { $nin: [cancelledKey] },
  };
  if (input.excludeId && OBJECT_ID.test(input.excludeId)) filter._id = { $ne: new mongoose.Types.ObjectId(input.excludeId) };

  const booked = await NativeWorkorder.find(filter)
    .select('staffId staffIds scheduledDate durationHours')
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean() as unknown as BookedWorkorder[];

  for (const wo of booked) {
    const start = wo.scheduledDate ? new Date(wo.scheduledDate) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    const own = Number(wo.durationHours);
    const hours = own > 0 ? own : defaultHours;
    const day = dayKeyFor(start, 'instantOrMidnight', timeZone);
    let clash: Clash | null = null;
    if (!hours || day.allDay) {
      // No duration, or a date-only value: any work order that day blocks the whole day.
      if (day.key === dayKey) clash = { allDay: true, after: nextDayStart };
    } else {
      const before = start.getTime() - hours * HOUR_MS;
      const after = start.getTime() + 2 * hours * HOUR_MS;
      if (at >= before && at < after) clash = { allDay: false, after, before };
    }
    if (!clash) continue;
    const assigned = new Set([wo.staffId, ...(wo.staffIds ?? [])].map((key) => String(key ?? '').trim()));
    for (const key of keys) {
      if (!assigned.has(key)) continue;
      const earlier = clashes.get(key);
      clashes.set(key, earlier ? widest(earlier, clash) : clash);
    }
  }
  return answer();
}
