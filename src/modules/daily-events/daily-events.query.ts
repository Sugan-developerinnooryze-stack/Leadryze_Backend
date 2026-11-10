import { DataScope } from '../../types';
import { peekStages } from '../native-crm/pipeline-config/pipeline-config.service';
import { BuiltInPipelineModule } from '../native-crm/pipeline-config/pipeline-config.model';
import { DailyEventBucket } from './daily-events.types';
import { DAY_MS, DateRule, DayWindows, SERVER_TIMEZONE, keyStartUtc } from './daily-events.time';
import { StatusSpec } from './daily-events.sources';

/** Shared by the Daily Events service and its lead section: who may see
 * what, finished-status lookups, and the calendar-day computation the
 * database runs (so every count equals its list). */

export interface StageInfo { terminal: Set<string>; cancelled: Set<string>; labels: Map<string, string> }

export interface Gates {
  allowed: (permission: string) => boolean;
  flagOff: (flag: string) => boolean;
  scopeFor: (scopeKey: string) => DataScope;
  /** Any connector permission at all (admins: always). */
  anyConnectorAccess: boolean;
}

export async function loadStageInfo(tenantId: string, spec: StatusSpec, cache: Map<string, Promise<StageInfo>>): Promise<StageInfo> {
  if (!('pipeline' in spec)) {
    return { terminal: new Set(spec.terminal), cancelled: new Set(spec.cancelled), labels: new Map(Object.entries(spec.labels ?? {})) };
  }
  const module: BuiltInPipelineModule = spec.pipeline;
  if (!cache.has(module)) {
    cache.set(module, peekStages(tenantId, module).then((stages) => ({
      // Inactive stages still count: old records can sit in them.
      terminal: new Set(stages.filter((s) => s.isTerminal).map((s) => s.key)),
      cancelled: new Set(stages.filter((s) => s.isTerminal && (s.outcome === 'cancelled' || s.outcome === 'lost' || /cancel|lost|reject|disqualif/i.test(s.key))).map((s) => s.key)),
      labels: new Map(stages.map((s) => [s.key, s.label])),
    })));
  }
  return cache.get(module)!;
}

/* ── Calendar day of a stored date, computed by the database ────────────── */

export function dateString(field: string, format: string, timezone: string) {
  return { $dateToString: { date: `$${field}`, format, timezone } };
}

/** The database twin of dayKeyFor() (daily-events.time.ts): the record's
 * calendar day as YYYY-MM-DD under `rule`. Computing it in the query keeps
 * every count equal to its list. */
export function dayKeyExpression(field: string, rule: DateRule, tenantTz: string): Record<string, unknown> {
  const tenantKey = dateString(field, '%Y-%m-%d', tenantTz);
  if (rule === 'instant') return tenantKey;
  const serverMidnight = { $eq: [dateString(field, '%H:%M:%S.%L', SERVER_TIMEZONE), '00:00:00.000'] };
  const serverKey = dateString(field, '%Y-%m-%d', SERVER_TIMEZONE);
  if (rule === 'instantOrMidnight') return { $cond: [serverMidnight, serverKey, tenantKey] };
  const utcMidnight = { $eq: [dateString(field, '%H:%M:%S.%L', 'UTC'), '00:00:00.000'] };
  return { $cond: [utcMidnight, dateString(field, '%Y-%m-%d', 'UTC'), { $cond: [serverMidnight, serverKey, tenantKey] }] };
}

/** A generous stored-value range around the calendar days asked for (no
 * zone is more than 14 h from UTC), so the date index narrows the read
 * before the exact calendar day is computed. */
export function coarseRange(bucket: DailyEventBucket, windows: DayWindows): Record<string, Date> {
  const todayStart = keyStartUtc(windows.todayKey).getTime();
  if (bucket === 'today') return { $gte: new Date(todayStart - DAY_MS), $lt: new Date(todayStart + 2 * DAY_MS) };
  if (bucket === 'overdue') return { $lt: new Date(todayStart + 2 * DAY_MS) };
  return { $gte: new Date(todayStart), $lt: new Date(keyStartUtc(windows.upcomingEndKey).getTime() + 2 * DAY_MS) };
}

export function dayMatch(bucket: DailyEventBucket, windows: DayWindows): unknown {
  if (bucket === 'today') return windows.todayKey;
  if (bucket === 'overdue') return { $lt: windows.todayKey };
  return { $gt: windows.todayKey, $lte: windows.upcomingEndKey };
}
