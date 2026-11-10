import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import { Lead } from '../native-crm/leads/lead.model';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { NativeTimeline } from '../native-crm/timeline/timeline.model';
import { applyDataScopeToFilter } from '../native-crm/shared/data-scope';
import { peekStages } from '../native-crm/pipeline-config/pipeline-config.service';
import { IPipelineStage } from '../native-crm/pipeline-config/pipeline-config.model';
import { DAY_MS, DayWindows, addDaysToKey, isServerMidnight, keyStartUtc, localDateKey, localTime } from './daily-events.time';
import { Gates, StageInfo, loadStageInfo, dayKeyExpression, coarseRange } from './daily-events.query';
import {
  RECORD_SOURCES, LOOKUP_GATES, LEAD_FOLLOW_UP_MODULES, LEAD_RELATED_MODULES, LeadFollowUpModule, NameLookups, RecordSourceDef,
} from './daily-events.sources';
import { LeadCard, LeadFollowUpItem, LeadInsights, LeadStageInfo } from './daily-events.types';

/** "Stuck" when a lead has had no activity for this many days (default). */
export const DEFAULT_STALE_LEAD_DAYS = 7;
const LIST_LIMIT = 10;
const STAGE_PREVIEW = 6;
const NEEDS_ACTION_LIMIT = 12;
/** Lead ids per $in query. */
const ID_CHUNK = 5000;
const UNKNOWN_STAGE_COLOR = '#94a3b8';
/** Follow-up titles never need customer or staff names. */
const NO_NAMES: NameLookups = { customer: () => undefined, staff: () => undefined };

/** Display fields only — no registered PII (email, phone, address…). */
const LEAD_FIELDS: Record<string, 1> = {
  firstName: 1, lastName: 1, company: 1, leadId: 1, status: 1, source: 1, leadOwner: 1, leadOwnerStaffId: 1,
  createdAt: 1, lastActivityAt: 1, isConverted: 1, convertedCustomerId: 1, contactId: 1, opportunityId: 1,
  'conversionHistory.type': 1, 'conversionHistory.createdAt': 1,
};
const LEAD_OUTPUT: Record<string, string> = Object.fromEntries(
  ['firstName', 'lastName', 'company', 'leadId', 'status', 'source', 'leadOwner', 'leadOwnerStaffId', 'createdAt',
    'lastActivityAt', 'isConverted', 'convertedCustomerId', 'contactId', 'opportunityId', 'conversionHistory', '_id']
    .map((f) => [f, `$${f}`]),
);

export interface LeadInsightsContext {
  tenantId: string;
  branchId: string | null;
  dataScopeFailed?: boolean;
}

interface FollowUp { leadId: string; dayKey: string; date: Date; kind: LeadFollowUpModule; title: string; allDay: boolean }

/** One follow-up module as read for this user. */
interface ModuleRead {
  def: RecordSourceDef;
  module: LeadFollowUpModule;
  /** Open items linked to a lead (same rule as the event rows' leadFollowUp flag). */
  open: Record<string, unknown>;
  /** Completed items linked to a lead; null when the module has no "done" status. */
  done: Record<string, unknown> | null;
  /** Per linked lead: open items due today / overdue, and the earliest one. */
  rows: Array<{ _id: unknown; today?: number; overdue?: number; first?: Record<string, unknown> }>;
}

interface RawFollowUpItem { read: ModuleRead; doc: any }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function humanise(key: string): string {
  const t = key.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'No stage';
}

function dayDiff(fromKey: string, toKey: string): number {
  return Math.round((keyStartUtc(toKey).getTime() - keyStartUtc(fromKey).getTime()) / DAY_MS);
}

function empty(status: LeadInsights['status'], staleDays: number): LeadInsights {
  return { source: 'field_service', status, staleDays, stages: [], followUpModules: [], followUpFailed: [] };
}

function toObjectIds(ids: Iterable<string>): mongoose.Types.ObjectId[] {
  return Array.from(ids).filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
}

function isAllDay(def: RecordSourceDef, date: Date): boolean {
  return def.dateRule === 'date' || (def.dateRule === 'instantOrMidnight' && isServerMidnight(date));
}

/** When completed work happened: its own date, or its last update when that
 * is earlier (a task finished before it was due) — never later than now. */
function touchTime(date: unknown, updatedAt: unknown, now: Date): Date | null {
  const times = [date, updatedAt]
    .map((v) => (v ? new Date(v as string | Date).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times, now.getTime())) : null;
}

/** The Lead Activity & Conversion section of Daily Events. Same gates as
 * the Leads screen (fs_leads + native_crm.leads.view, branch, DataScope on
 * owner or creator); stages, finished stages and won / lost outcomes come
 * from the tenant's own pipeline, so renamed or added stages just work.
 * Follow-ups and completed work come only from modules the user can see, and
 * only for leads the user can see. Read-only, deterministic, no AI. */
export async function buildLeadInsights(
  ctx: LeadInsightsContext, gates: Gates, windows: DayWindows, staleDays: number, stageCache: Map<string, Promise<StageInfo>>,
): Promise<LeadInsights> {
  const leadDef = RECORD_SOURCES.find((d) => d.module === 'lead')!;
  if (gates.flagOff(leadDef.flag)) return empty('disabled', staleDays);
  if (!gates.allowed(leadDef.permission)) return empty('no_permission', staleDays);
  if (ctx.dataScopeFailed) return empty('error', staleDays);

  const tid = new mongoose.Types.ObjectId(ctx.tenantId);
  const tz = windows.timezone;
  const today = windows.todayKey;
  const now = windows.now;

  // 1. The tenant's own pipeline.
  const pipeline: IPipelineStage[] = [...await peekStages(ctx.tenantId, 'lead')].sort((a, b) => a.order - b.order);
  const stageByKey = new Map(pipeline.map((s) => [s.key, s]));
  const finished = new Set(pipeline.filter((s) => s.isTerminal).map((s) => s.key));
  const wonKeys = new Set(pipeline.filter((s) => s.outcome === 'won').map((s) => s.key));
  const lostKeys = new Set(pipeline.filter((s) => s.outcome === 'lost').map((s) => s.key));

  const base: Record<string, unknown> = { tenantId: tid };
  if (ctx.branchId) base.branchId = new mongoose.Types.ObjectId(ctx.branchId);
  applyDataScopeToFilter(base, gates.scopeFor(leadDef.scopeKey), 'leadOwnerStaffId', undefined, undefined, 'createdBy');
  const open: Record<string, unknown> = finished.size ? { status: { $nin: Array.from(finished) } } : {};
  const all = (...parts: Record<string, unknown>[]) => ({ $and: [base, ...parts.filter((p) => Object.keys(p).length)] });

  /** Which of these leads match `extra` for this user, with their stage. */
  const visibleLeads = async (ids: Iterable<string>, extra: Record<string, unknown> = {}): Promise<Map<string, string>> => {
    const oids = toObjectIds(ids);
    const found = new Map<string, string>();
    for (let i = 0; i < oids.length; i += ID_CHUNK) {
      const rows = await Lead.find(all(extra, { _id: { $in: oids.slice(i, i + ID_CHUNK) } })).select('_id status').lean() as any[];
      for (const r of rows) found.set(String(r._id), typeof r.status === 'string' ? r.status : '');
    }
    return found;
  };

  // 2. Leads per stage, with a short preview of each.
  const stageRows = await Lead.aggregate([
    { $match: base },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        preview: { $topN: { n: STAGE_PREVIEW, sortBy: { lastActivityAt: -1, _id: 1 }, output: LEAD_OUTPUT } },
      },
    },
  ]) as Array<{ _id: string | null; count: number; preview: any[] }>;
  const countByStage = new Map(stageRows.map((r) => [r._id ?? '', r]));

  const stages: LeadStageInfo[] = [];
  for (const s of pipeline) {
    const count = countByStage.get(s.key)?.count ?? 0;
    if (!s.isActive && count === 0) continue;
    stages.push({ key: s.key, label: s.label, color: s.color || UNKNOWN_STAGE_COLOR, order: s.order, finished: s.isTerminal, outcome: s.outcome ?? null, active: s.isActive, count });
  }
  // A stage on leads that the pipeline no longer has is still shown, never dropped.
  for (const r of stageRows) {
    const key = r._id ?? '';
    if (stageByKey.has(key)) continue;
    stages.push({ key, label: humanise(key), color: UNKNOWN_STAGE_COLOR, order: 9999, finished: false, outcome: null, active: true, unknown: true, count: r.count });
  }
  const stageView = (key: unknown): LeadCard['stage'] => {
    const k = typeof key === 'string' ? key : '';
    const s = stageByKey.get(k);
    return s
      ? { key: k, label: s.label, color: s.color || UNKNOWN_STAGE_COLOR, finished: s.isTerminal, outcome: s.outcome ?? null }
      : { key: k, label: humanise(k), color: UNKNOWN_STAGE_COLOR, finished: false, outcome: null };
  };
  const total = stageRows.reduce((n, r) => n + r.count, 0);
  const openCount = stageRows.filter((r) => !finished.has(r._id ?? '')).reduce((n, r) => n + r.count, 0);

  // 3. Calls, meetings, tasks and activities linked to a lead, from the
  //    modules this user can see: the open ones are follow-ups, the
  //    completed ones count as activity on the lead.
  const followUpModules: string[] = [];
  const followUpFailed: string[] = [];
  const markFailed = (def: RecordSourceDef, err: unknown, what: string) => {
    if (!followUpFailed.includes(def.label)) followUpFailed.push(def.label);
    logger.warn(`Daily events: lead ${what} read failed`, { tenantId: ctx.tenantId, module: def.module, error: (err as Error).message });
  };
  const staleKey = addDaysToKey(today, -staleDays);
  // Earlier than the tenant-local start of the day after staleKey, in any time zone.
  const touchFloor = keyStartUtc(staleKey);
  const reads: ModuleRead[] = [];
  /** Latest completed work per lead. */
  const touchByLead = new Map<string, Date>();
  const addTouches = (def: RecordSourceDef, rows: any[]) => {
    for (const r of rows) {
      const at = touchTime(r[def.dateField], r.updatedAt, now);
      const leadId = String(r.relatedId);
      if (at && (!touchByLead.has(leadId) || touchByLead.get(leadId)! < at)) touchByLead.set(leadId, at);
    }
  };
  for (const module of LEAD_FOLLOW_UP_MODULES) {
    const def = RECORD_SOURCES.find((d) => d.module === module)!;
    if (gates.flagOff(def.flag) || !gates.allowed(def.permission)) continue;
    followUpModules.push(def.label);
    try {
      const info = await loadStageInfo(ctx.tenantId, def.status, stageCache);
      const linked: Record<string, unknown> = { tenantId: tid, relatedModule: { $in: LEAD_RELATED_MODULES }, relatedId: { $nin: [null, ''] }, [def.dateField]: { $ne: null } };
      if (def.branchScoped && ctx.branchId) linked.branchId = new mongoose.Types.ObjectId(ctx.branchId);
      def.applyScope(linked, gates.scopeFor(def.scopeKey));
      const stillOpen: Record<string, unknown> = { ...(def.openFilter ?? {}) };
      if (info.terminal.size) stillOpen[def.status.field] = { $nin: Array.from(info.terminal) };
      const doneStatuses = Array.from(info.terminal).filter((s) => !info.cancelled.has(s));
      const read: ModuleRead = {
        def, module,
        open: { $and: [linked, stillOpen] },
        done: doneStatuses.length ? { $and: [linked, { [def.status.field]: { $in: doneStatuses } }] } : null,
        rows: [],
      };
      read.rows = await def.model.aggregate([
        { $match: read.open },
        { $addFields: { __dayKey: dayKeyExpression(def.dateField, def.dateRule, tz) } },
        { $sort: { __dayKey: 1, [def.dateField]: 1, _id: 1 } },
        {
          $group: {
            _id: '$relatedId',
            today: { $sum: { $cond: [{ $eq: ['$__dayKey', today] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $lt: ['$__dayKey', today] }, 1, 0] } },
            first: { $first: { date: `$${def.dateField}`, dayKey: '$__dayKey', title: '$title', subject: '$subject', contactName: '$contactName' } },
          },
        },
      ]);
      // Recent completed work: enough to decide "stuck" for every lead.
      if (read.done) {
        addTouches(def, await def.model.find({ $and: [read.done, { [def.dateField]: { $gte: touchFloor } }] }).select(`relatedId ${def.dateField} updatedAt`).lean() as any[]);
      }
      reads.push(read);
    } catch (err) {
      markFailed(def, err, 'follow-ups');
    }
  }

  // Only open leads this user can see count — a Lost lead's leftover task, or
  // another branch's lead, is never a follow-up here.
  const visibleOpen = await visibleLeads(new Set(reads.flatMap((r) => r.rows.map((row) => String(row._id)))), open);
  let followUpsToday = 0;
  let followUpsOverdue = 0;
  const plannedLeadIds = new Set<string>();
  const nextByLead = new Map<string, FollowUp>();
  for (const read of reads) {
    for (const row of read.rows) {
      const leadId = String(row._id);
      if (!visibleOpen.has(leadId)) continue;
      followUpsToday += row.today ?? 0;
      followUpsOverdue += row.overdue ?? 0;
      // Any open follow-up — overdue ones too — means one is planned.
      plannedLeadIds.add(leadId);
      const first = row.first ?? {};
      const date = new Date(first.date as string);
      if (Number.isNaN(date.getTime()) || typeof first.dayKey !== 'string') continue;
      const candidate: FollowUp = {
        leadId, dayKey: first.dayKey, date, kind: read.module, title: read.def.toEvent(first, NO_NAMES).title, allDay: isAllDay(read.def, date),
      };
      const prev = nextByLead.get(leadId);
      if (!prev || candidate.dayKey < prev.dayKey || (candidate.dayKey === prev.dayKey && candidate.date < prev.date)) nextByLead.set(leadId, candidate);
    }
  }

  // The follow-ups behind the two counts, read by the same rule.
  const rawItems: { today: RawFollowUpItem[]; overdue: RawFollowUpItem[] } = { today: [], overdue: [] };
  for (const read of reads) {
    const ids = read.rows.filter((row) => visibleOpen.has(String(row._id)) && (row.today || row.overdue)).map((row) => String(row._id));
    if (!ids.length) continue;
    const { def } = read;
    const fields: Record<string, 1> = { [def.dateField]: 1, __dayKey: 1, relatedId: 1, title: 1, subject: 1, contactName: 1, direction: 1, type: 1 };
    try {
      const [result] = await def.model.aggregate([
        { $match: { $and: [read.open, { relatedId: { $in: ids } }] } },
        { $addFields: { __dayKey: dayKeyExpression(def.dateField, def.dateRule, tz) } },
        {
          $facet: {
            today: [{ $match: { __dayKey: today } }, { $sort: { [def.dateField]: 1, _id: 1 } }, { $limit: LIST_LIMIT }, { $project: fields }],
            overdue: [{ $match: { __dayKey: { $lt: today } } }, { $sort: { __dayKey: 1, [def.dateField]: 1, _id: 1 } }, { $limit: LIST_LIMIT }, { $project: fields }],
          },
        },
      ]);
      for (const doc of result?.today ?? []) rawItems.today.push({ read, doc });
      for (const doc of result?.overdue ?? []) rawItems.overdue.push({ read, doc });
    } catch (err) {
      markFailed(def, err, 'follow-up list');
    }
  }
  const itemTime = (i: RawFollowUpItem) => new Date(i.doc[i.read.def.dateField]).getTime();
  rawItems.today = rawItems.today.sort((a, b) => itemTime(a) - itemTime(b)).slice(0, LIST_LIMIT);
  rawItems.overdue = rawItems.overdue
    .sort((a, b) => String(a.doc.__dayKey).localeCompare(String(b.doc.__dayKey)) || itemTime(a) - itemTime(b))
    .slice(0, LIST_LIMIT);

  // 4. The lists. Every count and its list come from one aggregation.
  const listOf = async (filter: Record<string, unknown>, sort: Record<string, 1 | -1>, extra: any[] = []) => {
    const [result] = await Lead.aggregate([
      { $match: filter },
      ...extra,
      { $facet: { total: [{ $count: 'n' }], items: [{ $sort: { ...sort, _id: 1 } }, { $limit: LIST_LIMIT }, { $project: LEAD_FIELDS }] } },
    ]);
    return { count: (result?.total?.[0]?.n as number | undefined) ?? 0, items: (result?.items as any[] | undefined) ?? [] };
  };
  // "No follow-up planned" is only known when every follow-up module was read.
  const followUpsComplete = followUpModules.length > 0 && followUpFailed.length === 0;
  // Stuck = last activity (the lead's own update, or completed work linked to
  // it) on a tenant-local day at least staleDays before today.
  const touchedSinceStale = toObjectIds(Array.from(touchByLead).filter(([, at]) => localDateKey(at, tz) > staleKey).map(([leadId]) => leadId));
  const staleBound = keyStartUtc(addDaysToKey(staleKey, 2));
  const notCustomer = { isConverted: { $ne: true }, convertedCustomerId: { $in: [null, ''] }, 'conversionHistory.type': { $ne: 'customer' } };

  const [newToday, noFollowUp, stuck, readyToConvert] = await Promise.all([
    listOf(all({ createdAt: coarseRange('today', windows) }), { createdAt: -1 }, [
      { $addFields: { __dayKey: dayKeyExpression('createdAt', 'instant', tz) } },
      { $match: { __dayKey: today } },
    ]),
    followUpsComplete
      ? listOf(all(open, { _id: { $nin: toObjectIds(plannedLeadIds) } }), { lastActivityAt: 1, createdAt: 1 })
      : Promise.resolve(null),
    listOf(
      all(open, { $or: [{ lastActivityAt: { $lt: staleBound } }, { lastActivityAt: null }] }, touchedSinceStale.length ? { _id: { $nin: touchedSinceStale } } : {}),
      { lastActivityAt: 1, createdAt: 1 },
      [
        { $addFields: { __lastAt: { $ifNull: ['$lastActivityAt', '$createdAt'] } } },
        { $addFields: { __lastKey: dayKeyExpression('__lastAt', 'instant', tz) } },
        { $match: { __lastKey: { $lte: staleKey } } },
      ],
    ),
    wonKeys.size
      ? listOf(all({ status: { $in: Array.from(wonKeys) } }, notCustomer), { lastActivityAt: -1 })
      : Promise.resolve({ count: 0, items: [] as any[] }),
  ]);

  // 5. What changed today: conversion steps (from the conversion history) and
  //    moves into a won / lost stage (from the stage history).
  const conversionsToday = await Lead.aggregate([
    { $match: all({ 'conversionHistory.createdAt': coarseRange('today', windows) }) },
    { $unwind: '$conversionHistory' },
    { $addFields: { __dayKey: dayKeyExpression('conversionHistory.createdAt', 'instant', tz) } },
    { $match: { __dayKey: today } },
    { $project: { type: '$conversionHistory.type', at: '$conversionHistory.createdAt' } },
  ]) as Array<{ _id: unknown; type: string; at: Date }>;
  const CONVERSION_RANK: Record<string, number> = { customer: 3, opportunity: 2, contact: 1 };
  const conversionByLead = new Map<string, { change: NonNullable<LeadCard['change']>; at: Date }>();
  for (const c of conversionsToday) {
    if (c.type !== 'customer' && c.type !== 'contact' && c.type !== 'opportunity') continue;
    const leadId = String(c._id);
    const at = new Date(c.at);
    const prev = conversionByLead.get(leadId);
    if (!prev || CONVERSION_RANK[c.type] > CONVERSION_RANK[prev.change]) conversionByLead.set(leadId, { change: c.type, at: prev && prev.at > at ? prev.at : at });
    else if (at > prev.at) prev.at = at;
  }

  // Each lead's newest stage move today. Only entries that moved a stage
  // count: convert-to-contact / opportunity entries carry no `to`, and a
  // convert-to-customer entry is a move only when the lead wasn't already won
  // (older entries without `from` are skipped, never guessed).
  const lastMove = new Map<string, { to: string; at: Date }>();
  if (wonKeys.size || lostKeys.size) {
    const entries = await NativeTimeline.find({
      tenantId: tid, entityModule: 'leads', action: { $in: ['status_changed', 'converted'] }, createdAt: coarseRange('today', windows),
    }).select('entityId action metadata.from metadata.to createdAt').sort({ createdAt: -1, _id: -1 }).lean() as any[];
    for (const e of entries) {
      const leadId = String(e.entityId);
      const at = new Date(e.createdAt);
      if (lastMove.has(leadId) || Number.isNaN(at.getTime()) || localDateKey(at, tz) !== today) continue;
      const to = typeof e.metadata?.to === 'string' ? e.metadata.to : undefined;
      if (!to) continue;
      if (e.action === 'converted') {
        const from = typeof e.metadata?.from === 'string' ? e.metadata.from : undefined;
        if (!from || from === to || wonKeys.has(from)) continue;
      }
      lastMove.set(leadId, { to, at });
    }
  }
  const outcomeCandidates = Array.from(lastMove).filter(([, m]) => wonKeys.has(m.to) || lostKeys.has(m.to));
  const outcomeLeads = await visibleLeads(outcomeCandidates.map(([leadId]) => leadId));
  const outcomeByLead = new Map<string, { outcome: 'won' | 'lost'; at: Date }>();
  for (const [leadId, m] of outcomeCandidates) {
    const status = outcomeLeads.get(leadId);
    if (status === undefined) continue;
    const outcome = wonKeys.has(m.to) ? 'won' : 'lost';
    // Still there now: a lead moved to Lost and later converted is not "lost today".
    if (outcome === 'won' ? wonKeys.has(status) : lostKeys.has(status)) outcomeByLead.set(leadId, { outcome, at: m.at });
  }
  const newestFirst = <T extends { at: Date }>(map: Map<string, T>, keep: (v: T) => boolean = () => true) =>
    Array.from(map).filter(([, v]) => keep(v)).sort(([, a], [, b]) => b.at.getTime() - a.at.getTime()).map(([leadId]) => leadId);
  const convertedIds = newestFirst(conversionByLead, (c) => c.change === 'customer');
  const outcomeIds = newestFirst(outcomeByLead);

  // 6. Load every other lead a card is needed for — only ones this user can see.
  const overdueLeadIds = Array.from(nextByLead.values()).filter((f) => f.dayKey < today)
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.date.getTime() - b.date.getTime()).map((f) => f.leadId);
  const wanted = new Set([
    ...overdueLeadIds.slice(0, NEEDS_ACTION_LIMIT), ...convertedIds.slice(0, LIST_LIMIT), ...outcomeIds.slice(0, LIST_LIMIT),
    ...[...rawItems.today, ...rawItems.overdue].map((i) => String(i.doc.relatedId)),
  ]);
  const wantedIds = toObjectIds(wanted);
  const loaded = wantedIds.length
    ? await Lead.find(all({ _id: { $in: wantedIds } })).select(LEAD_FIELDS).lean() as any[]
    : [];
  const loadedById = new Map(loaded.map((d) => [String(d._id), d]));

  const docs = [
    ...newToday.items, ...(noFollowUp?.items ?? []), ...stuck.items, ...readyToConvert.items, ...loaded,
    ...stageRows.flatMap((r) => r.preview ?? []),
  ];

  // Older completed work for the leads on screen, so "last activity N days
  // ago" is exact (recent work was read above).
  const olderTouchIds = Array.from(new Set(docs.map((d) => String(d._id)).filter((leadId) => !touchByLead.has(leadId))));
  if (olderTouchIds.length) {
    for (const read of reads) {
      if (!read.done) continue;
      try {
        addTouches(read.def, await read.def.model.find({ $and: [read.done, { relatedId: { $in: olderTouchIds } }] }).select(`relatedId ${read.def.dateField} updatedAt`).lean() as any[]);
      } catch (err) {
        markFailed(read.def, err, 'completed-work');
      }
    }
  }

  // Owner names: the name stored on the lead, else the staff record (when the user may see Staff).
  const staffNames = new Map<string, string>();
  const staffIds = Array.from(new Set(docs.filter((d) => !text(d.leadOwner) && text(d.leadOwnerStaffId)).map((d) => text(d.leadOwnerStaffId)!)));
  if (staffIds.length && !gates.flagOff(LOOKUP_GATES.staff.flag) && gates.allowed(LOOKUP_GATES.staff.permission)) {
    try {
      const rows = await NativeStaff.find({ tenantId: tid, staffId: { $in: staffIds } }).select('staffId firstName lastName').lean() as any[];
      for (const r of rows) {
        const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
        if (r.staffId && name) staffNames.set(r.staffId, name);
      }
    } catch (err) {
      logger.warn('Daily events: lead owner lookup failed', { tenantId: ctx.tenantId, error: (err as Error).message });
    }
  }

  // Every read is done; from here on it's only shaping the response.
  const complete = followUpsComplete && followUpFailed.length === 0;
  const followUpsKnown = followUpModules.length > followUpFailed.length;

  /** The next stage forward that is still open, or the won stage — never a
   * lost / disqualified one. */
  const activeOrder = pipeline.filter((s) => s.isActive);
  const nextStageLabel = (key: string): string | undefined => {
    const index = activeOrder.findIndex((s) => s.key === key);
    if (index < 0) return undefined;
    return activeOrder.slice(index + 1).find((s) => !s.isTerminal || s.outcome === 'won')?.label;
  };
  const leadName = (doc: any) => [text(doc.firstName), text(doc.lastName)].filter(Boolean).join(' ') || text(doc.company) || text(doc.leadId) || 'Lead';
  const leadLink = (leadId: string) => ({ path: `/native-crm/leads?lead=${leadId}`, exact: true });

  const toCard = (doc: any): LeadCard => {
    const id = String(doc._id);
    const history: Array<{ type?: string }> = Array.isArray(doc.conversionHistory) ? doc.conversionHistory : [];
    const own = doc.lastActivityAt ? new Date(doc.lastActivityAt) : doc.createdAt ? new Date(doc.createdAt) : null;
    const touch = touchByLead.get(id);
    const lastAt = own && !Number.isNaN(own.getTime()) ? (touch && touch > own ? touch : own) : touch ?? null;
    const lastActivityDate = lastAt ? localDateKey(lastAt, tz) : undefined;
    const f = nextByLead.get(id);
    // Same "has an owner" rule as the Leads screen; the name only when this user may see it.
    const hasOwner = !!(text(doc.leadOwnerStaffId) || text(doc.leadOwner));
    const card: LeadCard = {
      id,
      name: leadName(doc),
      company: text(doc.company),
      leadId: text(doc.leadId),
      stage: stageView(doc.status),
      source: text(doc.source),
      owner: text(doc.leadOwner) ?? staffNames.get(text(doc.leadOwnerStaffId) ?? '') ?? (hasOwner ? 'Assigned' : undefined),
      createdDate: doc.createdAt ? localDateKey(new Date(doc.createdAt), tz) : undefined,
      lastActivityDate,
      daysSinceActivity: lastActivityDate ? Math.max(0, dayDiff(lastActivityDate, today)) : undefined,
      nextFollowUp: f ? {
        date: f.dayKey,
        time: f.allDay ? undefined : localTime(f.date, tz),
        kind: f.kind,
        title: f.title,
        overdue: f.dayKey < today,
      } : undefined,
      conversion: {
        contact: !!text(doc.contactId) || history.some((h) => h.type === 'contact'),
        opportunity: !!text(doc.opportunityId) || history.some((h) => h.type === 'opportunity'),
        // Same "Converted" the Leads screen shows.
        customer: doc.isConverted === true || !!text(doc.convertedCustomerId) || history.some((h) => h.type === 'customer'),
      },
      change: conversionByLead.get(id)?.change,
      outcome: outcomeByLead.get(id)?.outcome,
      link: leadLink(id),
    };
    card.suggestion = suggestionFor(card);
    return card;
  };

  /** A next step from the record and the pipeline — the most urgent first. */
  const suggestionFor = (card: LeadCard): LeadCard['suggestion'] => {
    if (card.stage.outcome === 'won' && !card.conversion.customer) {
      return { kind: 'convert', text: `${card.stage.label} — convert this lead to a customer` };
    }
    if (card.stage.finished) return undefined;
    if (card.nextFollowUp?.overdue) {
      const late = dayDiff(card.nextFollowUp.date, today);
      return { kind: 'follow_up_overdue', text: `Follow-up "${card.nextFollowUp.title}" is ${late} day${late === 1 ? '' : 's'} overdue` };
    }
    const quiet = (card.daysSinceActivity ?? 0) >= staleDays;
    if (!card.nextFollowUp && complete) {
      return { kind: 'plan_follow_up', text: `${quiet ? `No activity for ${card.daysSinceActivity} days and no` : 'No'} follow-up planned — schedule a call, meeting or task` };
    }
    // A planned follow-up already is the way back in touch.
    if (quiet && !card.nextFollowUp) return { kind: 're_engage', text: `No activity for ${card.daysSinceActivity} days — get back in touch` };
    if (!card.owner) return { kind: 'assign_owner', text: 'No owner yet — assign someone to this lead' };
    const next = nextStageLabel(card.stage.key);
    return next ? { kind: 'advance', text: `Next stage: ${next}` } : undefined;
  };

  const toFollowUpItem = ({ read, doc }: RawFollowUpItem): LeadFollowUpItem | null => {
    const leadId = String(doc.relatedId);
    const lead = loadedById.get(leadId);
    const date = new Date(doc[read.def.dateField]);
    if (!lead || Number.isNaN(date.getTime()) || typeof doc.__dayKey !== 'string') return null;
    const parts = read.def.toEvent(doc, NO_NAMES);
    return {
      id: `${read.module}:${String(doc._id)}`,
      kind: read.module,
      title: parts.title,
      date: doc.__dayKey,
      time: isAllDay(read.def, date) ? undefined : localTime(date, tz),
      overdue: doc.__dayKey < today,
      lead: { id: leadId, name: leadName(lead), stage: stageView(lead.status) },
      link: parts.link,
      leadLink: leadLink(leadId),
    };
  };

  // 7. "Needs action": ready to convert, overdue follow-up, nothing planned, stuck.
  const needsAction: LeadCard[] = [];
  const seen = new Set<string>();
  let needsActionTruncated = readyToConvert.count > readyToConvert.items.length
    || overdueLeadIds.length > NEEDS_ACTION_LIMIT
    || (!!noFollowUp && complete && noFollowUp.count > noFollowUp.items.length)
    || stuck.count > stuck.items.length;
  const pushUnique = (doc: any) => {
    const id = String(doc._id);
    if (seen.has(id)) return;
    if (needsAction.length >= NEEDS_ACTION_LIMIT) { needsActionTruncated = true; return; }
    seen.add(id);
    needsAction.push(toCard(doc));
  };
  readyToConvert.items.forEach(pushUnique);
  overdueLeadIds.slice(0, NEEDS_ACTION_LIMIT).map((id) => loadedById.get(id)).filter((d) => d && !finished.has(d.status)).forEach(pushUnique);
  if (complete) noFollowUp?.items.forEach(pushUnique);
  stuck.items.forEach(pushUnique);

  const cardsFor = (ids: string[]) => ids.slice(0, LIST_LIMIT).map((id) => loadedById.get(id)).filter(Boolean).map(toCard);
  const byStage: Record<string, LeadCard[]> = {};
  for (const r of stageRows) byStage[r._id ?? ''] = (r.preview ?? []).map(toCard);
  const outcomeCount = (kind: 'won' | 'lost') => Array.from(outcomeByLead.values()).filter((o) => o.outcome === kind).length;

  return {
    source: 'field_service',
    status: 'ok',
    staleDays,
    stages,
    counts: {
      total,
      open: openCount,
      newToday: newToday.count,
      followUpsToday: followUpsKnown ? followUpsToday : null,
      followUpsOverdue: followUpsKnown ? followUpsOverdue : null,
      noFollowUp: complete && noFollowUp ? noFollowUp.count : null,
      stuck: stuck.count,
      readyToConvert: readyToConvert.count,
      convertedToday: convertedIds.length,
      wonToday: outcomeCount('won'),
      lostToday: outcomeCount('lost'),
    },
    lists: {
      needsAction,
      needsActionTruncated,
      newToday: newToday.items.map(toCard),
      noFollowUp: complete && noFollowUp ? noFollowUp.items.map(toCard) : [],
      stuck: stuck.items.map(toCard),
      readyToConvert: readyToConvert.items.map(toCard),
      convertedToday: cardsFor(convertedIds),
      outcomesToday: cardsFor(outcomeIds),
      followUpsToday: rawItems.today.map(toFollowUpItem).filter((i): i is LeadFollowUpItem => !!i),
      followUpsOverdue: rawItems.overdue.map(toFollowUpItem).filter((i): i is LeadFollowUpItem => !!i),
    },
    byStage,
    followUpModules,
    followUpFailed,
  };
}
