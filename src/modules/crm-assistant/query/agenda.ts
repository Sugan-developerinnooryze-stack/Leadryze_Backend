import type { Cond, QueryPlan, RelRange, SourceKey } from '../contracts/plan';
import { QueryPlanSchema, SOURCE_KEYS } from '../contracts/plan';
import { isKnownAppLink } from '../contracts/routes';
import type { ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import { queryStatesFor } from '../registry/query-caps';
import type { AssistIdentity } from '../identity';
import { GatewayTenant, TENANT_INACTIVE_MESSAGE, resolveScopeForIdentity } from '../gates';
import type { PlanProblem } from './validate';
import { RelatedGate, relatedLabels } from './relations';
import { dateExprToKey, dayRangeFragment, resolveRelRange } from './compile';
import { scopedAggregate } from './scoped-match';
import { dayText } from '../views/chips';
import { effectiveScopeFor } from '../../internal/crm-gateway.helpers';
import { isForbiddenReadKey } from '../../internal/crm-read.service';
import { DEFAULT_DATA_SCOPE_CONFIG } from '../../native-crm/shared/data-scope';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { DailyEventsContext, SECTION_LIMITS, getDailyEvents } from '../../daily-events/daily-events.service';
import { compareEvents } from '../../daily-events/daily-events.connectors';
import {
  CONTRACT_VISITS, LEAD_FOLLOW_UP_MODULES, NameLookups, RECORD_SOURCES, RecordSourceDef, isLeadRelated,
} from '../../daily-events/daily-events.sources';
import { StageInfo, dayKeyExpression, loadStageInfo } from '../../daily-events/daily-events.query';
import {
  DAY_MS, addDaysToKey, buildDayWindows, isServerMidnight, keyStartUtc, localDateKey, localTime,
} from '../../daily-events/daily-events.time';
import type { DailyEvent, DailyEventBucket, DailyEventsResponse } from '../../daily-events/daily-events.types';
import type { DataScope } from '../../../types';
import { logger } from '../../../utils/logger';

/* Agenda windows (Increment 8): what is due or scheduled in a window, one
 * group per module of one source. Executor D asks Daily Events itself
 * (getDailyEvents, unchanged) for today, overdue, the next 7 days and the
 * whole view while its switch is on; executor Q reads each Daily Events
 * module through scoped-match.ts with Daily Events' own day rules for every
 * other window. Reads only; Daily Events code is imported, never changed.
 *
 * The rules Q applies to each day of a window, relative to today, are Daily
 * Events' (daily-events.service.ts fetchRecordSource and recordEvent, which
 * are private there and restated here): today lists every status, other days
 * only what is still open (not in the module's finished stages, plus its
 * openFilter), past days most recent first and in the alert tone; the
 * calendar day is dayKeyExpression with the module's DateRule; a list and
 * its count come from one aggregation, so totals are exact. A part reads as
 * many records as Daily Events reads for that section, in the same stored
 * order, and lists the first of them in the panel's own order (its
 * compareEvents), so both list the same records on the days both cover. Contract visits
 * follow the contract group (active contracts only, never overdue). Each
 * module runs under its own gates (gateRelated), at most six at a time,
 * each by the module deadline: a module that fails or is late is a group in
 * an error state, never a 0. Customer and staff names come from the label
 * modules under their own gates (relatedLabels) and are cosmetic: a failed
 * or late lookup shows the stored numbers. A meeting's Daily Events subtitle
 * is its location, which the assistant never reads out, so meetings carry
 * no subtitle on either executor. */

export const AGENDA_MAX_DAYS = 92;
export const AGENDA_ITEMS_PER_BUCKET = 5;
export const AGENDA_ITEMS_PER_BLOCK = 80;

export type AgendaBucketKind = 'overdue' | 'today' | 'upcoming' | 'window';
export type AgendaExecutor = 'D' | 'Q';

export interface AgendaPart { bucket: AgendaBucketKind; from: string | null; to: string | null; label?: string }

export interface AgendaWindow {
  kind: 'daily_events' | 'today' | 'overdue' | 'upcoming' | 'range';
  /** Inclusive tenant-local day keys; null: open-ended. */
  from: string | null; to: string | null;
  title: string; label: string;
  todayKey: string; timezone: string; timezoneFallback: boolean;
  parts: AgendaPart[];
}

export type AgendaPlanCheck = { ok: true; plan: QueryPlan } | { ok: false; problems: PlanProblem[]; tooLong?: boolean };

/* ── Plans and windows ─────────────────────────────────────────────────── */

type DailyEventsKind = Exclude<AgendaWindow['kind'], 'range'>;
/** The windows that are Daily Events' own sections (executor D while its switch is on). */
const DAILY_EVENTS_KINDS: ReadonlySet<AgendaWindow['kind']> = new Set<AgendaWindow['kind']>(['daily_events', 'today', 'overdue', 'upcoming']);
/** The plan keys an agenda takes. */
const AGENDA_PLAN_KEYS: ReadonlySet<string> = new Set(['v', 'op', 'target', 'window', 'where', 'present']);

const REL_TITLES: Readonly<Record<RelRange, string>> = {
  today: 'Today', yesterday: 'Yesterday', tomorrow: 'Tomorrow',
  this_week: 'This week', last_week: 'Last week', next_week: 'Next week',
  this_month: 'This month', last_month: 'Last month', next_month: 'Next month',
  this_quarter: 'This quarter', last_quarter: 'Last quarter', this_year: 'This year', last_year: 'Last year',
  last_7_days: 'Last 7 days', next_7_days: 'Next 7 days', last_30_days: 'Last 30 days', next_30_days: 'Next 30 days',
};
/** Periods whose parts name them ("Earlier this week, still open", "Rest of this month"). */
const NAMED_PERIODS: ReadonlySet<RelRange> = new Set<RelRange>(['this_week', 'this_month', 'this_quarter']);

const TEXTS = {
  target: "An agenda covers every module; ask for one module's list instead.",
  key: (key: string) => `"${key}" can't be used with an agenda.`,
  where: 'An agenda takes only the overdue filter, and then no dates.',
  present: 'An agenda is always shown as an agenda.',
  noSuchDate: "That date doesn't exist.",
  backwards: 'The period ends before it starts.',
  tooLong: 'An agenda covers at most 3 months at a time. Ask for a shorter period.',
};

function humanise(key: string): string {
  const t = key.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : key;
}

/** Whole days from one day key to another. */
function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((keyStartUtc(toKey).getTime() - keyStartUtc(fromKey).getTime()) / DAY_MS);
}

/** "2 to 8 Nov 2026", "28 Oct to 3 Nov 2026", "28 Dec 2026 to 3 Jan 2027"; one day reads as dayText. */
function rangeText(fromKey: string, toKey: string): string {
  if (fromKey === toKey) return dayText(fromKey);
  const start = dayText(fromKey);
  if (fromKey.slice(0, 4) !== toKey.slice(0, 4)) return `${start} to ${dayText(toKey)}`;
  const dayMonth = start.slice(0, start.lastIndexOf(' '));
  const sameMonth = fromKey.slice(0, 7) === toKey.slice(0, 7);
  return `${sameMonth ? dayMonth.slice(0, dayMonth.indexOf(' ')) : dayMonth} to ${dayText(toKey)}`;
}

function isOverdueState(cond: Cond): boolean {
  return cond.op === 'state' && cond.v === 'overdue' && Object.keys(cond).length === 2;
}

/** The inclusive day keys a window names (a relative range, or written dates). Throws RangeError for a date that doesn't exist. */
function windowKeys(window: NonNullable<QueryPlan['window']>, timezone: string, now: Date): { from: string; to: string } {
  if (typeof window === 'string') {
    const range = resolveRelRange(window, timezone, now);
    return { from: range.fromKey, to: range.toKey };
  }
  return { from: dateExprToKey(window.from, timezone, now), to: dateExprToKey(window.to, timezone, now) };
}

/** Today, the timezone it is counted in, and the last day of Daily Events' "next 7 days". */
interface DayBasis { todayKey: string; timezone: string; timezoneFallback: boolean; upcomingEndKey: string }

/** Daily Events' own sections for a plan, or null for any other window. */
function dailyEventsKindOf(plan: QueryPlan): DailyEventsKind | null {
  if (plan.window === undefined) return (plan.where ?? []).some(isOverdueState) ? 'overdue' : 'daily_events';
  if (plan.window === 'today') return 'today';
  // The agenda's "next 7 days" is Daily Events': the 7 days after today.
  if (plan.window === 'next_7_days') return 'upcoming';
  return null;
}

/** "What's on today" is Today plus Overdue; the whole view is all three of Daily Events' sections. */
function dailyEventsWindow(kind: DailyEventsKind, basis: DayBasis): AgendaWindow {
  const t = basis.todayKey;
  const before = addDaysToKey(t, -1);
  const after = addDaysToKey(t, 1);
  const end = basis.upcomingEndKey;
  const day = { todayKey: t, timezone: basis.timezone, timezoneFallback: basis.timezoneFallback };
  const today: AgendaPart = { bucket: 'today', from: t, to: t };
  const overdue: AgendaPart = { bucket: 'overdue', from: null, to: before };
  const upcoming: AgendaPart = { bucket: 'upcoming', from: after, to: end };
  switch (kind) {
    case 'today': return { kind, from: null, to: t, title: 'Today', label: `${dayText(t)} and anything overdue`, ...day, parts: [today, overdue] };
    case 'overdue': return { kind, from: null, to: before, title: 'Overdue', label: `Before ${dayText(t)}, still open`, ...day, parts: [overdue] };
    case 'upcoming': return { kind, from: after, to: end, title: 'Next 7 days', label: rangeText(after, end), ...day, parts: [upcoming] };
    default: return {
      kind, from: null, to: end, title: 'Daily Events', label: `Overdue, today and ${rangeText(after, end)}`, ...day, parts: [today, overdue, upcoming],
    };
  }
}

/** Any other window, split by Daily Events' rules: the days before today (open only), today (every status), the days after. */
function rangeWindow(window: NonNullable<QueryPlan['window']>, basis: DayBasis, now: Date): AgendaWindow {
  const t = basis.todayKey;
  const { from, to } = windowKeys(window, basis.timezone, now);
  const named = typeof window === 'string' ? window : null;
  const title = named ? REL_TITLES[named] : 'Agenda';
  const period = named && NAMED_PERIODS.has(named) ? title.toLowerCase() : null;
  const holdsToday = from <= t && t <= to;
  const parts: AgendaPart[] = [];
  if (from < t) {
    const before = addDaysToKey(t, -1);
    const label = to < t ? 'Still open' : period ? `Earlier ${period}, still open` : 'Earlier, still open';
    parts.push({ bucket: 'overdue', from, to: to < before ? to : before, label });
  }
  if (holdsToday) parts.push({ bucket: 'today', from: t, to: t });
  if (to > t) {
    const after = addDaysToKey(t, 1);
    const label = holdsToday ? (period ? `Rest of ${period}` : 'Later in this period') : undefined;
    parts.push({ bucket: 'window', from: from > after ? from : after, to, ...(label ? { label } : {}) });
  }
  return {
    kind: 'range', from, to, title, label: rangeText(from, to),
    todayKey: t, timezone: basis.timezone, timezoneFallback: basis.timezoneFallback, parts,
  };
}

/** An agenda plan, strictly: op 'agenda' on the concept 'agenda' (optional `sources`), a window
 * or the overdue state (not both), presentation 'auto' at most, and real dates in order. A window
 * over AGENDA_MAX_DAYS days comes back `tooLong`. */
export function validateAgendaPlan(input: unknown, timezone: string, now: Date = new Date()): AgendaPlanCheck {
  const parsed = QueryPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 5).map((issue) => ({
        code: 'invalid_plan' as const,
        path: issue.path.join('.'),
        message: `Plan ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }
  const plan = parsed.data;
  if (plan.op !== 'agenda') return { ok: false, problems: [{ code: 'unsupported_op', path: 'op', message: 'This is not an agenda plan.' }] };

  const problems: PlanProblem[] = [];
  if (!('concept' in plan.target) || plan.target.concept !== 'agenda') problems.push({ code: 'unsupported_target', path: 'target', message: TEXTS.target });
  for (const key of Object.keys(plan)) {
    if (!AGENDA_PLAN_KEYS.has(key)) problems.push({ code: 'unsupported_option', path: key, message: TEXTS.key(key) });
  }
  if (plan.where !== undefined && !(plan.where.length === 1 && isOverdueState(plan.where[0]) && plan.window === undefined)) {
    problems.push({ code: 'unsupported_condition', path: 'where', message: TEXTS.where });
  }
  if (plan.present !== undefined && plan.present !== 'auto') problems.push({ code: 'unsupported_option', path: 'present', message: TEXTS.present });
  if (problems.length) return { ok: false, problems };

  if (plan.window !== undefined) {
    let keys: { from: string; to: string };
    try {
      keys = windowKeys(plan.window, timezone, now);
    } catch {
      return { ok: false, problems: [{ code: 'invalid_value', path: 'window', message: TEXTS.noSuchDate }] };
    }
    if (keys.from > keys.to) return { ok: false, problems: [{ code: 'invalid_value', path: 'window', message: TEXTS.backwards }] };
    if (daysBetween(keys.from, keys.to) + 1 > AGENDA_MAX_DAYS) {
      return { ok: false, tooLong: true, problems: [{ code: 'invalid_value', path: 'window', message: TEXTS.tooLong }] };
    }
  }
  return { ok: true, plan };
}

/** The validated plan's window in the tenant's timezone (an invalid one counts in UTC and says so). */
export function resolveAgendaWindow(plan: QueryPlan, timezone: string, now: Date = new Date()): AgendaWindow {
  const days = buildDayWindows(timezone, now);
  const basis: DayBasis = { todayKey: days.todayKey, timezone: days.timezone, timezoneFallback: days.timezoneFallback, upcomingEndKey: days.upcomingEndKey };
  const kind = dailyEventsKindOf(plan);
  return kind ? dailyEventsWindow(kind, basis) : rangeWindow(plan.window!, basis, now);
}

/** Daily Events' own sections go to Daily Events while its switch is on; everything else, and all of them while it is off, to Q. */
export function chooseAgendaExecutor(window: AgendaWindow, dailyEventsOn: boolean): AgendaExecutor {
  return dailyEventsOn && DAILY_EVENTS_KINDS.has(window.kind) ? 'D' : 'Q';
}

/** Exactly what the Daily Events route builds for this caller (daily-events.routes.ts): the BASE data
 * scope (never undefined: resolveEffectiveScope would read that as every record), the tenant's
 * data-visibility config over the defaults, its effective flags. A scope that can't be resolved
 * fails closed as resolveDataScopeMiddleware does: the 'self' scope that matches nothing, marked
 * failed, so Daily Events shows those modules as errors. The cache key of getDailyEvents ignores the
 * scope, so this object must equal the route's for the same caller. */
export async function dailyEventsContextFor(identity: AssistIdentity, tenant: GatewayTenant, now?: Date): Promise<DailyEventsContext> {
  const caller = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    branchId: identity.branchId ?? null,
    role: identity.role,
    ...(identity.roleId ? { roleId: identity.roleId } : {}),
    featureFlags: tenant.flags as Record<string, boolean | undefined>,
  };
  const at = now ? { now } : {};
  try {
    const dataScope = await resolveScopeForIdentity(identity.tenantId, identity);
    return { ...caller, dataScope, dataScopeConfig: { ...DEFAULT_DATA_SCOPE_CONFIG, ...(tenant.dataScopeConfig ?? {}) }, ...at };
  } catch {
    return {
      ...caller, dataScope: { kind: 'self', staffIds: [], teamIds: [], createdByUserIds: [] }, dataScopeConfig: DEFAULT_DATA_SCOPE_CONFIG,
      dataScopeFailed: true, ...at,
    };
  }
}

export interface AgendaItemOut {
  key: string; title: string; subtitle?: string; kind: string; date: string; time?: string; endTime?: string; allDay: boolean;
  status?: { key: string; label: string; tone: 'open' | 'done' | 'cancelled' | 'alert' }; daysLate?: number;
  assignee?: string; related?: string; leadFollowUp: boolean; link?: { path: string; exact: boolean };
}

export type AgendaGroupState = 'ok' | 'disabled' | 'no_permission' | 'error' | 'timeout' | 'not_synced' | 'no_dates';

export interface AgendaGroupOut {
  source: SourceKey; module: string; moduleLabel: string;
  scopeKind: 'all' | 'team' | 'self';
  state: AgendaGroupState; note?: string;
  freshness?: { syncStatus: string; lastSyncAt: string | null };
  buckets: Array<{ bucket: AgendaBucketKind; label?: string; items: AgendaItemOut[]; total: number | null; lowerBound: boolean; drill?: QueryPlan }>;
}

export interface AgendaOutcome {
  executor: AgendaExecutor; window: AgendaWindow; groups: AgendaGroupOut[];
  /** D: the connectors couldn't be read (DESV's 'connector:unavailable' source). */
  connectorsUnavailable?: boolean;
  /** D: Daily Events' notIncluded sentences. */
  notIncluded?: string[];
}

type AgendaBucketOut = AgendaGroupOut['buckets'][number];
type ScopeKind = AgendaGroupOut['scopeKind'];
type Doc = Record<string, any>;

/** Modules whose Daily Events subtitle is a field the assistant never reads out (the meeting's location). */
const NO_SUBTITLE_MODULES: ReadonlySet<string> = new Set(['meeting']);

function isSourceKey(key: string): key is SourceKey {
  return (SOURCE_KEYS as readonly string[]).includes(key);
}

function daysLateOf(dateKey: string, todayKey: string): { daysLate?: number } {
  const days = daysBetween(dateKey, todayKey);
  return days >= 1 ? { daysLate: days } : {};
}

/** A link the chat can open (the route table); anything else is left out, never sent. */
function knownLink(link: { path: string; exact: boolean } | undefined): { link?: { path: string; exact: boolean } } {
  return link && isKnownAppLink(link.path) ? { link: { path: link.path, exact: link.exact } } : {};
}

/** The chat lists at most AGENDA_ITEMS_PER_BUCKET items in a bucket and AGENDA_ITEMS_PER_BLOCK in
 * the block: every bucket that has items keeps min(5, floor(80 / such buckets)), at least 1, in its
 * own order. Totals are never changed. */
function withItemBudget(groups: AgendaGroupOut[]): AgendaGroupOut[] {
  const listed = groups.reduce((n, g) => n + g.buckets.filter((b) => b.items.length > 0).length, 0);
  const each = Math.max(1, Math.min(AGENDA_ITEMS_PER_BUCKET, Math.floor(AGENDA_ITEMS_PER_BLOCK / Math.max(1, listed))));
  let left = AGENDA_ITEMS_PER_BLOCK;
  return groups.map((g) => ({
    ...g,
    buckets: g.buckets.map((b) => {
      const items = b.items.slice(0, Math.max(0, Math.min(each, left)));
      left -= items.length;
      return { ...b, items };
    }),
  }));
}

/* ── Executor D: Daily Events itself ───────────────────────────────────── */

/** One Daily Events event as an agenda item: a link only where the chat has a page (a connector's has none). */
function eventItem(event: DailyEvent, todayKey: string): AgendaItemOut {
  return {
    key: event.id,
    title: event.title,
    ...(event.subtitle && !NO_SUBTITLE_MODULES.has(event.module) ? { subtitle: event.subtitle } : {}),
    kind: event.kind,
    date: event.date,
    ...(event.time ? { time: event.time } : {}),
    ...(event.endTime ? { endTime: event.endTime } : {}),
    allDay: event.allDay,
    ...(event.status ? { status: { key: event.status.key, label: event.status.label, tone: event.status.tone } } : {}),
    ...(event.bucket === 'overdue' ? daysLateOf(event.date, todayKey) : {}),
    ...(event.assignee ? { assignee: event.assignee } : {}),
    ...(event.related?.label ? { related: event.related.label } : {}),
    leadFollowUp: event.leadFollowUp,
    ...knownLink(event.link),
  };
}

/** Daily Events' answer as agenda groups, in its own order (Native CRM, Field Service, then each
 * connector; modules as it lists them, contract visits after contract end dates): only the
 * window's sections a module has, its status, its exact counts (a lower bound for a connector
 * module past its scan limit), and the first items of each section in the panel's own order.
 * Pure: tested on a fixture response. */
export function agendaFromDailyEvents(res: DailyEventsResponse, window: AgendaWindow, scopeKindOf: (scopeKey: string) => 'all' | 'team' | 'self'): AgendaOutcome {
  const groups: AgendaGroupOut[] = [];
  let connectorsUnavailable = false;
  for (const source of res.sources) {
    if (source.key === 'connector:unavailable') { connectorsUnavailable = true; continue; }
    if (!isSourceKey(source.key)) continue;
    const sourceKey = source.key;
    const connector = sourceKey.startsWith('connector:');
    for (const m of source.modules) {
      const parts = window.parts.filter((p) => (m.buckets as readonly string[]).includes(p.bucket));
      if (!parts.length) continue;
      const def = connector ? undefined : RECORD_SOURCES.find((d) => d.module === m.module);
      const scopeKey = def?.scopeKey ?? (!connector && m.module === CONTRACT_VISITS.module ? CONTRACT_VISITS.scopeKey : undefined);
      const cap = def ? getModuleCap(def.module) : undefined;
      const buckets: AgendaBucketOut[] = m.status !== 'ok' ? [] : parts.map((part) => {
        const drill = def && cap ? agendaDrillPlan(def, cap, part, res.date) : undefined;
        const count = m.counts?.[part.bucket as DailyEventBucket];
        return {
          bucket: part.bucket,
          ...(part.label ? { label: part.label } : {}),
          items: res.events.filter((e) => e.source === sourceKey && e.module === m.module && e.bucket === part.bucket).map((e) => eventItem(e, res.date)),
          total: typeof count === 'number' ? count : null,
          lowerBound: !!m.incomplete,
          ...(drill ? { drill } : {}),
        };
      });
      groups.push({
        source: sourceKey, module: m.module, moduleLabel: m.label,
        scopeKind: scopeKey ? scopeKindOf(scopeKey) : 'all',
        state: m.status,
        ...(m.note ? { note: m.note } : {}),
        ...(connector && source.connector ? { freshness: { syncStatus: source.connector.syncStatus, lastSyncAt: source.connector.lastSyncAt } } : {}),
        buckets,
      });
    }
  }
  return {
    executor: 'D', window, groups: withItemBudget(groups),
    ...(connectorsUnavailable ? { connectorsUnavailable: true } : {}),
    notIncluded: [...res.notIncluded],
  };
}

/** Executor D: getDailyEvents unchanged (never `fresh`), with the route's own context, so the chat
 * and the panel share its short cache. The window is rebuilt from the answer's own day and
 * timezone (a cached copy may be from just before midnight). Each module's scope label comes from
 * the same base scope, with the module's data-visibility toggle (as the panel's own reads). */
export async function runAgendaD(input: { identity: AssistIdentity; tenant: GatewayTenant; window: AgendaWindow; now?: Date }): Promise<AgendaOutcome> {
  const ctx = await dailyEventsContextFor(input.identity, input.tenant, input.now);
  const res = await getDailyEvents(ctx);
  const window = input.window.kind === 'range' ? input.window : dailyEventsWindow(input.window.kind, {
    todayKey: res.date, timezone: res.timezone, timezoneFallback: res.timezoneFallback, upcomingEndKey: res.upcomingThrough,
  });
  const base: DataScope = ctx.dataScope ?? { kind: 'self', staffIds: [], teamIds: [], createdByUserIds: [] };
  return agendaFromDailyEvents(res, window, (scopeKey) => effectiveScopeFor(base, input.tenant.dataScopeConfig, scopeKey).kind);
}

/* ── Executor Q: each module through scoped-match.ts ───────────────────── */

/** Modules read at the same time. */
const MODULE_CONCURRENCY = 6;
const LATE = Symbol('late');
const TENANT_INACTIVE = Symbol('tenant_inactive');
/** What a visit row keeps (as Daily Events' contract visits). */
const VISIT_FIELDS = { title: 1, contractId: 1, customerId: 1, visits: 1, __dayKey: 1 };
/** The visits Daily Events reads (daily-events.service.ts VISIT_LIMITS, private there): today, and later days. */
const VISIT_LIMITS = { today: 50, later: 25 };

interface QRun {
  identity: AssistIdentity;
  related: RelatedGate;
  window: AgendaWindow;
  now: Date;
  stages: Map<string, Promise<StageInfo>>;
  /** Settles at the module deadline; null: no deadline. */
  late: Promise<typeof LATE> | null;
  deadline?: number;
}

/** The phase that decides a module's state: its gates and its one aggregation. */
type ModuleRead =
  | { kind: 'refused'; reason: 'disabled' | 'no_permission' | 'unknown_module' | 'tenant_inactive' }
  | { kind: 'read'; scopeKind: ScopeKind; info: StageInfo; row: Doc | undefined }
  | { kind: 'failed' };

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function statusOf(raw: unknown, info: StageInfo, alert: boolean): AgendaItemOut['status'] {
  if (typeof raw !== 'string' || !raw) return undefined;
  const label = info.labels.get(raw) ?? humanise(raw);
  if (alert) return { key: raw, label, tone: 'alert' };
  if (info.cancelled.has(raw)) return { key: raw, label, tone: 'cancelled' };
  if (info.terminal.has(raw)) return { key: raw, label, tone: 'done' };
  return { key: raw, label, tone: 'open' };
}

/** def.select without the keys the assistant never reads out (READ_FORBIDDEN_KEYS: a meeting's location), plus the day key. */
function projectionOf(select: string): Record<string, 1> {
  const projection: Record<string, 1> = { __dayKey: 1 };
  for (const field of select.split(/\s+/).filter(Boolean)) if (!isForbiddenReadKey(field)) projection[field] = 1;
  return projection;
}

/** The day keys of one part. */
function dayMatchOf(part: AgendaPart): unknown {
  if (part.bucket === 'today') return part.from;
  return { ...(part.from ? { $gte: part.from } : {}), $lte: part.to };
}

function itemsOf(row: Doc | undefined, part: AgendaPart): Doc[] {
  const items = row?.[`${part.bucket}Items`];
  return Array.isArray(items) ? items : [];
}

function totalOf(row: Doc | undefined, part: AgendaPart): number {
  const n = row?.[`${part.bucket}Total`]?.[0]?.n;
  return typeof n === 'number' ? n : 0;
}

/** The Daily Events section whose rules, read limit and order a part follows (later days are "upcoming"). */
function sectionOf(part: AgendaPart): DailyEventBucket {
  return part.bucket === 'window' ? 'upcoming' : part.bucket;
}

/** What Daily Events' compareEvents reads of an event, besides its section. */
type PanelSlot = Pick<DailyEvent, 'id' | 'date' | 'time' | 'allDay'>;

/** The rows a part lists, each with its slot: the first AGENDA_ITEMS_PER_BUCKET in the panel's own
 * order (compareEvents: the day, all-day first, the time, then the id; overdue most recent first) of
 * the rows read, which are the ones the panel reads for that section. A row the panel makes no event
 * of is left out. */
function panelFirst(part: AgendaPart, rows: readonly Doc[], slotOf: (row: Doc) => PanelSlot | null): Array<{ row: Doc; slot: PanelSlot }> {
  const bucket = sectionOf(part);
  const event = (slot: PanelSlot) => ({ ...slot, bucket }) as DailyEvent;
  return rows
    .map((row) => ({ row, slot: slotOf(row) }))
    .filter((r): r is { row: Doc; slot: PanelSlot } => r.slot !== null)
    .sort((a, b) => compareEvents(event(a.slot), event(b.slot)))
    .slice(0, AGENDA_ITEMS_PER_BUCKET);
}

/** `work` unless the module deadline passes first. */
function beforeLate<T>(run: QRun, work: Promise<T>): Promise<T | typeof LATE> {
  return run.late ? Promise.race([work, run.late]) : work;
}

/** Names are cosmetic: a lookup that fails, or is still running at the deadline, gives none (the
 * stored numbers are shown), never an error or a timeout for the module. */
function cosmeticLabels(run: QRun, module: 'customer' | 'staff', ids: Set<string>, keyPath: string, forModule: string): Promise<Map<string, string>> {
  if (!ids.size) return Promise.resolve(new Map());
  const lookup = relatedLabels(run.related, module, [...ids], { keyPath }).catch(() => {
    logger.warn('CRM assist: agenda name lookup failed; stored numbers shown', { module: forModule, lookup: module });
    return new Map<string, string>();
  });
  return run.late ? Promise.race([lookup, run.late.then(() => new Map<string, string>())]) : lookup;
}

function collectIds(target: Set<string>, values: unknown[] | undefined): void {
  for (const v of values ?? []) if (typeof v === 'string' && v.trim()) target.add(v.trim());
}

async function namesFor(run: QRun, forModule: string, customerIds: Set<string>, staffIds: Set<string>): Promise<NameLookups> {
  const [customers, staff] = await Promise.all([
    cosmeticLabels(run, 'customer', customerIds, 'customerId', forModule),
    cosmeticLabels(run, 'staff', staffIds, 'staffId', forModule),
  ]);
  return {
    customer: (id) => (typeof id === 'string' ? customers.get(id) : undefined),
    staff: (id) => (typeof id === 'string' ? staff.get(id) : undefined),
  };
}

/** recordEvent's id, day, time and all-day flag for a record read; null where it makes no event. */
function recordSlot(def: RecordSourceDef, doc: Doc, timezone: string): PanelSlot | null {
  const raw = doc[def.dateField];
  if (!raw || typeof doc.__dayKey !== 'string') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const allDay = def.dateRule === 'date' || (def.dateRule === 'instantOrMidnight' && isServerMidnight(at));
  return { id: `${def.source}:${def.module}:${String(doc._id)}`, date: doc.__dayKey, ...(allDay ? {} : { time: localTime(at, timezone) }), allDay };
}

/** Daily Events' recordEvent, restated: the day and time in the tenant's timezone, the module's
 * "what the date means", the status tone (alert for every past day and a breached SLA), a lead
 * follow-up only while open. */
function recordItem(def: RecordSourceDef, part: AgendaPart, doc: Doc, slot: PanelSlot, info: StageInfo, names: NameLookups, run: QRun): AgendaItemOut {
  const tz = run.window.timezone;
  const { date, allDay } = slot;
  const statusValue = doc[def.status.field];
  const open = !(typeof statusValue === 'string' && info.terminal.has(statusValue)) && (def.isOpen?.(doc) ?? true);
  const parts = def.toEvent(doc, names);
  const kind = def.kind(part.bucket === 'window' ? 'upcoming' : part.bucket, doc, { now: run.now, open });
  const endTime = !allDay && parts.endAt && localDateKey(new Date(parts.endAt), tz) === date ? localTime(new Date(parts.endAt), tz) : undefined;
  const status = statusOf(statusValue, info, part.bucket === 'overdue' || kind === 'SLA breached');
  return {
    key: slot.id,
    title: parts.title,
    ...(parts.subtitle && !NO_SUBTITLE_MODULES.has(def.module) ? { subtitle: parts.subtitle } : {}),
    kind,
    date,
    ...(slot.time ? { time: slot.time } : {}),
    ...(endTime ? { endTime } : {}),
    allDay,
    ...(status ? { status } : {}),
    ...(part.bucket === 'overdue' ? daysLateOf(date, run.window.todayKey) : {}),
    ...(parts.assignee ? { assignee: parts.assignee } : {}),
    ...(parts.related?.label ? { related: parts.related.label } : {}),
    leadFollowUp: open && (LEAD_FOLLOW_UP_MODULES as readonly string[]).includes(def.module) && isLeadRelated(doc.relatedModule),
    ...knownLink(parts.link),
  };
}

/** The gates (gateRelated: flag, view permission, then the module's own scope and branch), then one
 * aggregation over the window: the scoped $match with the window's day range, the day key, and a
 * $facet with a count and the records of each part that Daily Events reads for its section (its
 * sort and SECTION_LIMITS; today any status, other days open only). */
async function readModule(def: RecordSourceDef, cap: ModuleCap, run: QRun): Promise<ModuleRead> {
  const side = await run.related(def.module);
  if (!side.ok) return { kind: 'refused', reason: side.reason };
  const info = await loadStageInfo(run.identity.tenantId, def.status, run.stages);
  const open: Record<string, unknown> = { ...(def.openFilter ?? {}) };
  if (info.terminal.size) open[def.status.field] = { $nin: Array.from(info.terminal) };
  const { window } = run;
  const facet: Record<string, Doc[]> = {};
  for (const part of window.parts) {
    const match = { __dayKey: dayMatchOf(part), ...(part.bucket === 'today' ? {} : open) };
    const dir = part.bucket === 'overdue' ? -1 : 1;
    facet[`${part.bucket}Total`] = [{ $match: match }, { $count: 'n' }];
    facet[`${part.bucket}Items`] = [
      { $match: match },
      { $sort: { __dayKey: dir, [def.dateField]: dir, _id: 1 } },
      { $limit: SECTION_LIMITS[sectionOf(part)] },
      { $project: projectionOf(def.select) },
    ];
  }
  const [row] = await scopedAggregate(cap, side.ctx, [dayRangeFragment(def.dateField, def.dateRule, window.timezone, window.from ?? undefined, window.to ?? undefined)], [
    { $addFields: { __dayKey: dayKeyExpression(def.dateField, def.dateRule, window.timezone) } },
    { $facet: facet },
  ]);
  return { kind: 'read', scopeKind: side.ctx.scope.kind, info, row: row as Doc | undefined };
}

/** Contract visits of active contracts, under the contract module's gates, scope and branch: today
 * every visit, later days the planned or scheduled ones, never overdue (Daily Events' rules). */
async function readVisits(cap: ModuleCap, run: QRun, today: AgendaPart | undefined, later: AgendaPart | undefined): Promise<ModuleRead> {
  const side = await run.related(cap.key);
  if (!side.ok) return { kind: 'refused', reason: side.reason };
  const { window } = run;
  const t = window.todayKey;
  const stages = await peekStages(run.identity.tenantId, 'contract');
  const activeKeys = stages.filter((s) => s.outcome === 'active').map((s) => s.key);
  if (!activeKeys.length) activeKeys.push('active');
  const lo = today ? t : later!.from!;
  const hi = later ? later.to! : t;
  const coarse = { $gte: new Date(keyStartUtc(lo).getTime() - DAY_MS), $lt: new Date(keyStartUtc(hi).getTime() + 2 * DAY_MS) };
  const laterDays = later ? { __dayKey: { $gte: later.from, $lte: later.to }, 'visits.status': { $in: CONTRACT_VISITS.open } } : null;
  const facet: Record<string, Doc[]> = {};
  if (today) {
    facet.todayTotal = [{ $match: { __dayKey: t } }, { $count: 'n' }];
    facet.todayItems = [{ $match: { __dayKey: t } }, { $sort: { 'visits.visitNumber': 1, _id: 1 } }, { $limit: VISIT_LIMITS.today }, { $project: VISIT_FIELDS }];
  }
  if (later) {
    facet[`${later.bucket}Total`] = [{ $match: { __dayKey: { $gt: t } } }, { $count: 'n' }];
    facet[`${later.bucket}Items`] = [
      { $match: { __dayKey: { $gt: t } } }, { $sort: { __dayKey: 1, 'visits.visitNumber': 1, _id: 1 } }, { $limit: VISIT_LIMITS.later }, { $project: VISIT_FIELDS },
    ];
  }
  const [row] = await scopedAggregate(cap, side.ctx, [{ status: { $in: activeKeys } }, { 'visits.serviceDate': coarse }], [
    { $unwind: '$visits' },
    { $match: { 'visits.serviceDate': coarse } },
    { $addFields: { __dayKey: dayKeyExpression('visits.serviceDate', 'date', window.timezone) } },
    { $match: { $or: [...(today ? [{ __dayKey: t }] : []), ...(laterDays ? [laterDays] : [])] } },
    { $facet: facet },
  ]);
  const visitStages: StageInfo = { terminal: new Set(), cancelled: new Set(), labels: new Map() };
  return { kind: 'read', scopeKind: side.ctx.scope.kind, info: visitStages, row: row as Doc | undefined };
}

/** contractVisitEvent's id (the contract, then the visit number or else the day), its day, all day; null without a day. */
function visitSlot(row: Doc): PanelSlot | null {
  if (typeof row.__dayKey !== 'string') return null;
  const visit: Doc = row.visits && typeof row.visits === 'object' ? row.visits : {};
  return { id: `field_service:${CONTRACT_VISITS.module}:${String(row._id)}:${visit.visitNumber ?? row.__dayKey}`, date: row.__dayKey, allDay: true };
}

/** Daily Events' contractVisitEvent, restated. */
function visitItem(row: Doc, slot: PanelSlot, names: NameLookups): AgendaItemOut {
  const visit: Doc = row.visits && typeof row.visits === 'object' ? row.visits : {};
  const day = slot.date;
  const status = typeof visit.status === 'string' ? visit.status : '';
  const customer = names.customer(row.customerId) ?? (typeof row.customerId === 'string' ? row.customerId : undefined);
  const name = row.title ?? row.contractId ?? 'Contract';
  const subtitle = [row.contractId, customer].filter(Boolean).join(' · ');
  return {
    key: slot.id,
    title: visit.visitNumber != null ? `Visit ${visit.visitNumber} · ${name}` : `Visit · ${name}`,
    ...(subtitle ? { subtitle } : {}),
    kind: 'Service visit',
    date: day,
    allDay: true,
    ...(status ? {
      status: {
        key: status, label: humanise(status),
        tone: CONTRACT_VISITS.cancelled.includes(status) ? 'cancelled' : CONTRACT_VISITS.open.includes(status) ? 'open' : 'done',
      },
    } : {}),
    leadFollowUp: false,
    ...knownLink({ path: `/native-crm/contracts/${String(row._id)}`, exact: true }),
  };
}

/** One group: the read raced against the module deadline (late: 'timeout'; a throw: 'error'), then
 * the names (cosmetic), then its buckets. */
async function groupFor(
  run: QRun, shell: { source: SourceKey; module: string; moduleLabel: string },
  read: () => Promise<ModuleRead>,
  bucketsOf: (read: Extract<ModuleRead, { kind: 'read' }>, names: NameLookups) => AgendaBucketOut[],
  idsOf: (row: Doc | undefined, customers: Set<string>, staff: Set<string>) => void,
): Promise<AgendaGroupOut | null | typeof TENANT_INACTIVE> {
  const group = (state: AgendaGroupState, scopeKind: ScopeKind = 'all', buckets: AgendaBucketOut[] = []): AgendaGroupOut => ({ ...shell, scopeKind, state, buckets });
  if (run.deadline !== undefined && Date.now() >= run.deadline) return group('timeout');
  const settled = await beforeLate(run, read().catch((err): ModuleRead => {
    logger.warn('CRM assist: agenda module read failed', { module: shell.module, error: (err as Error)?.message });
    return { kind: 'failed' };
  }));
  if (settled === LATE) {
    logger.warn('CRM assist: agenda module did not finish in time', { module: shell.module });
    return group('timeout');
  }
  if (settled.kind === 'failed') return group('error');
  if (settled.kind === 'refused') {
    if (settled.reason === 'tenant_inactive') return TENANT_INACTIVE;
    if (settled.reason === 'unknown_module') {
      logger.warn('CRM assist: agenda module not served on executor Q; left out', { module: shell.module });
      return null;
    }
    return group(settled.reason);
  }
  const customers = new Set<string>();
  const staff = new Set<string>();
  idsOf(settled.row, customers, staff);
  const names = await namesFor(run, shell.module, customers, staff);
  try {
    return group('ok', settled.scopeKind, bucketsOf(settled, names));
  } catch (err) {
    logger.warn('CRM assist: agenda module rows could not be shown', { module: shell.module, error: (err as Error)?.message });
    return group('error', settled.scopeKind);
  }
}

function moduleGroup(def: RecordSourceDef, cap: ModuleCap, run: QRun): Promise<AgendaGroupOut | null | typeof TENANT_INACTIVE> {
  const { parts } = run.window;
  // Names are looked up only for the records listed.
  const listed = (row: Doc | undefined, part: AgendaPart) => panelFirst(part, itemsOf(row, part), (doc) => recordSlot(def, doc, run.window.timezone));
  return groupFor(
    run, { source: def.source, module: def.module, moduleLabel: def.label },
    () => readModule(def, cap, run),
    (read, names) => parts.map((part) => {
      const drill = agendaDrillPlan(def, cap, part, run.window.todayKey);
      return {
        bucket: part.bucket,
        ...(part.label ? { label: part.label } : {}),
        items: listed(read.row, part).map(({ row, slot }) => recordItem(def, part, row, slot, read.info, names, run)),
        total: totalOf(read.row, part),
        lowerBound: false,
        ...(drill ? { drill } : {}),
      };
    }),
    (row, customers, staff) => {
      for (const { row: doc } of parts.flatMap((part) => listed(row, part))) {
        collectIds(customers, def.customerIds?.(doc));
        collectIds(staff, def.staffIds?.(doc));
      }
    },
  );
}

function visitsGroup(cap: ModuleCap, run: QRun): Promise<AgendaGroupOut | null | typeof TENANT_INACTIVE> {
  const today = run.window.parts.find((p) => p.bucket === 'today');
  const later = run.window.parts.find((p) => p.bucket === 'upcoming' || p.bucket === 'window');
  const parts = [today, later].filter((p): p is AgendaPart => !!p);
  return groupFor(
    run, { source: 'field_service', module: CONTRACT_VISITS.module, moduleLabel: CONTRACT_VISITS.label },
    () => readVisits(cap, run, today, later),
    (read, names) => parts.map((part) => ({
      bucket: part.bucket,
      ...(part.label ? { label: part.label } : {}),
      items: panelFirst(part, itemsOf(read.row, part), visitSlot).map(({ row, slot }) => visitItem(row, slot, names)),
      total: totalOf(read.row, part),
      lowerBound: false,
    })),
    (row, customers) => {
      for (const { row: doc } of parts.flatMap((part) => panelFirst(part, itemsOf(row, part), visitSlot))) collectIds(customers, [doc.customerId]);
    },
  );
}

/** Executor Q: every Daily Events module whose registry entry exists (and contract visits right
 * after contract end dates, when the window has today or later days), each under its own gates,
 * at most six at a time, each by `moduleDeadline` (epoch ms). No connector groups. */
export async function runAgendaQ(input: {
  identity: AssistIdentity; tenant: GatewayTenant; related: RelatedGate; window: AgendaWindow; moduleDeadline: number; now?: Date;
}): Promise<AgendaOutcome> {
  const deadline = Number.isFinite(input.moduleDeadline) ? input.moduleDeadline : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = deadline === undefined ? null : new Promise<typeof LATE>((resolve) => {
    // Within setTimeout's limit, past which Node fires at once.
    timer = setTimeout(() => resolve(LATE), Math.min(Math.max(0, deadline - Date.now()), 0x7fffffff));
  });
  const run: QRun = {
    identity: input.identity, related: input.related, window: input.window, now: input.now ?? new Date(),
    stages: new Map(), late, ...(deadline !== undefined ? { deadline } : {}),
  };
  const visitsWanted = input.window.parts.some((p) => p.bucket !== 'overdue');
  const jobs: Array<() => Promise<AgendaGroupOut | null | typeof TENANT_INACTIVE>> = [];
  for (const def of RECORD_SOURCES) {
    const cap = getModuleCap(def.module);
    if (!cap) continue;
    jobs.push(() => moduleGroup(def, cap, run));
    if (def.module === 'contract' && visitsWanted) jobs.push(() => visitsGroup(cap, run));
  }
  let results: Array<AgendaGroupOut | null | typeof TENANT_INACTIVE>;
  try {
    results = await mapWithConcurrency(jobs, MODULE_CONCURRENCY, (job) => job());
  } finally {
    clearTimeout(timer);
  }
  if (results.includes(TENANT_INACTIVE)) throw new Error(TENANT_INACTIVE_MESSAGE);
  const groups = results.filter((g): g is AgendaGroupOut => g !== null && g !== TENANT_INACTIVE);
  return { executor: 'Q', window: input.window, groups: withItemBudget(groups) };
}

/** The list that shows one Daily Events bucket in full, on executor Q: the registry field that is
 * the module's Daily Events date, between the part's days (an overdue part with no start: before
 * today), plus the open state except today (any status), oldest first except overdue. It never
 * uses the overdue or due-today states (the invoice overdue state also checks paid, and due today
 * lists only open records), so its total equals the bucket's. */
export function agendaDrillPlan(def: RecordSourceDef, cap: ModuleCap, part: AgendaPart, todayKey: string): QueryPlan | undefined {
  const f = cap.fields.find((field) => field.path === def.dateField)?.key;
  if (!f) return undefined;
  const target = { module: cap.key };
  const day = (key: string) => ({ date: key });
  if (part.bucket === 'today') {
    return { v: 1, op: 'list', target, where: [{ f, op: 'between', v: [day(todayKey), day(todayKey)] }], sort: { by: f, dir: 'asc' } };
  }
  if (!queryStatesFor(cap).open || !part.to) return undefined;
  const open: Cond = { op: 'state', v: 'open' };
  if (part.bucket === 'overdue') {
    const when: Cond = part.from ? { f, op: 'between', v: [day(part.from), day(part.to)] } : { f, op: 'lt', v: day(addDaysToKey(part.to, 1)) };
    return { v: 1, op: 'list', target, where: [when, open], sort: { by: f, dir: 'desc' } };
  }
  if (!part.from) return undefined;
  return { v: 1, op: 'list', target, where: [{ f, op: 'between', v: [day(part.from), day(part.to)] }, open], sort: { by: f, dir: 'asc' } };
}
