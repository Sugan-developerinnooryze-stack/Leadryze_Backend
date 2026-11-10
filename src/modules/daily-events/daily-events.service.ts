import mongoose from 'mongoose';
import { DataScope } from '../../types';
import { logger } from '../../utils/logger';
import { Tenant } from '../tenants/tenant.model';
import { Connector } from '../connectors/connector.model';
import { CRMRecord } from '../crm/crm-record.model';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { NativeContract } from '../native-crm/contracts/contract.model';
import { resolveEffectiveScope, applyDataScopeToFilter } from '../native-crm/shared/data-scope';
import { peekStages } from '../native-crm/pipeline-config/pipeline-config.service';
import { getEffectivePermissions, permissionAllows } from '../rbac/permission.service';
import {
  DailyEvent, DailyEventBucket, DailyEventCounts, DailyEventStatus, DailyEventsModuleSummary,
  DailyEventsResponse, DailyEventsSource, DailyEventModuleStatus,
} from './daily-events.types';
import {
  DAY_MS, DayWindows, buildDayWindows, keyStartUtc, localDateKey, localTime, isServerMidnight,
} from './daily-events.time';
import { RECORD_SOURCES, RecordSourceDef, CONTRACT_VISITS, LOOKUP_GATES, NOT_INCLUDED, NameLookups, LEAD_FOLLOW_UP_MODULES, isLeadRelated } from './daily-events.sources';
import { Gates, StageInfo, loadStageInfo, dayKeyExpression, coarseRange, dayMatch } from './daily-events.query';
import { buildLeadInsights, DEFAULT_STALE_LEAD_DAYS } from './daily-events.leads';
import { getCrmAssistantSettings } from '../ai/crm-assistant-settings.service';
import { LeadInsights } from './daily-events.types';
import {
  CONNECTOR_EVENT_MODULES, CONNECTOR_LABELS, CONNECTOR_SCAN_LIMIT, compareEvents, connectorProjection, extractConnectorEvents,
} from './daily-events.connectors';

/** Events returned per module and section; counts are always exact. */
export const SECTION_LIMITS: Record<DailyEventBucket, number> = { today: 50, overdue: 15, upcoming: 25 };
/** Visits listed (today / upcoming); counts stay exact. */
const VISIT_LIMITS = { today: 50, upcoming: 25 };
/** Modules read at the same time (each runs up to three aggregations). */
const MODULE_CONCURRENCY = 4;

/** Everything about the caller comes from the verified request (JWT,
 * requireTenant, resolveBranch, resolveDataScopeMiddleware) — never from
 * query parameters and never from an AI. */
export interface DailyEventsContext {
  tenantId: string;
  userId: string;
  branchId: string | null;
  role: string;
  roleId?: string;
  featureFlags: Record<string, boolean | undefined>;
  dataScope: DataScope | undefined;
  dataScopeConfig: Record<string, boolean> | undefined;
  /** resolveDataScopeMiddleware failed closed: scoped modules can't be read. */
  dataScopeFailed?: boolean;
  now?: Date;
}

const EMPTY_COUNTS = (): DailyEventCounts => ({ today: 0, overdue: 0, upcoming: 0 });

function humanise(key: string): string {
  const t = key.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : key;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

/** Mirrors requirePermission (SUPER_ADMIN / TENANT_ADMIN always pass; anyone
 * else needs the key in their role) and requireModuleEnabled (blocked only
 * when the flag is explicitly false; SUPER_ADMIN bypasses). */
async function buildGates(ctx: DailyEventsContext): Promise<Gates> {
  const isAdmin = ctx.role === 'SUPER_ADMIN' || ctx.role === 'TENANT_ADMIN';
  const perms = isAdmin || !ctx.roleId ? null : await getEffectivePermissions(ctx.tenantId, ctx.roleId);
  // resolveEffectiveScope only reads these two request fields.
  const scopeReq = { dataScope: ctx.dataScope, dataScopeConfig: ctx.dataScopeConfig } as Parameters<typeof resolveEffectiveScope>[0];
  return {
    allowed: (permission) => isAdmin || (!!perms && permissionAllows(perms, permission)),
    flagOff: (flag) => ctx.role !== 'SUPER_ADMIN' && ctx.featureFlags?.[flag] === false,
    scopeFor: (scopeKey) => resolveEffectiveScope(scopeReq, scopeKey),
    anyConnectorAccess: isAdmin || (!!perms && Array.from(perms).some((key) => key.startsWith('connector.'))),
  };
}

function statusOf(raw: unknown, info: StageInfo, bucket: DailyEventBucket, forceAlert = false): DailyEventStatus | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const label = info.labels.get(raw) ?? humanise(raw);
  if (bucket === 'overdue' || forceAlert) return { key: raw, label, tone: 'alert' };
  if (info.cancelled.has(raw)) return { key: raw, label, tone: 'cancelled' };
  if (info.terminal.has(raw)) return { key: raw, label, tone: 'done' };
  return { key: raw, label, tone: 'open' };
}

function projectionOf(select: string): Record<string, 1> {
  const projection: Record<string, 1> = { __dayKey: 1 };
  for (const field of select.split(/\s+/).filter(Boolean)) projection[field] = 1;
  return projection;
}

interface ModuleFetch {
  counts: DailyEventCounts;
  truncated: { today: boolean; overdue: boolean; upcoming: boolean };
  rows: Array<{ bucket: DailyEventBucket; doc: any }>;
  stages: StageInfo;
}

/** Counts and lists one module's sections. Each section is one aggregation
 * whose count and list come from the same matched records, so a list can
 * never disagree with its count. Read-only. */
async function fetchRecordSource(
  def: RecordSourceDef, ctx: DailyEventsContext, gates: Gates, windows: DayWindows, stageCache: Map<string, Promise<StageInfo>>,
): Promise<ModuleFetch> {
  const base: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(ctx.tenantId) };
  if (def.branchScoped && ctx.branchId) base.branchId = new mongoose.Types.ObjectId(ctx.branchId);
  def.applyScope(base, gates.scopeFor(def.scopeKey));

  const stages = await loadStageInfo(ctx.tenantId, def.status, stageCache);
  const open: Record<string, unknown> = { ...(def.openFilter ?? {}) };
  if (stages.terminal.size) open[def.status.field] = { $nin: Array.from(stages.terminal) };

  const results = await Promise.all(def.buckets.map(async (bucket) => {
    const sort = bucket === 'overdue' ? -1 : 1;
    const [result] = await def.model.aggregate([
      // Today lists every status; overdue / upcoming only what is still open.
      { $match: { ...base, ...(bucket === 'today' ? {} : open), [def.dateField]: coarseRange(bucket, windows) } },
      { $addFields: { __dayKey: dayKeyExpression(def.dateField, def.dateRule, windows.timezone) } },
      { $match: { __dayKey: dayMatch(bucket, windows) } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          items: [
            { $sort: { __dayKey: sort, [def.dateField]: sort, _id: 1 } },
            { $limit: SECTION_LIMITS[bucket] },
            { $project: projectionOf(def.select) },
          ],
        },
      },
    ]);
    return { bucket, count: (result?.total?.[0]?.n as number | undefined) ?? 0, docs: (result?.items as any[] | undefined) ?? [] };
  }));

  const counts = EMPTY_COUNTS();
  const truncated = { today: false, overdue: false, upcoming: false };
  const rows: ModuleFetch['rows'] = [];
  for (const { bucket, count, docs } of results) {
    counts[bucket] = count;
    truncated[bucket] = docs.length < count;
    for (const doc of docs) rows.push({ bucket, doc });
  }
  return { counts, truncated, rows, stages };
}

function recordEvent(def: RecordSourceDef, row: { bucket: DailyEventBucket; doc: any }, stages: StageInfo, names: NameLookups, windows: DayWindows): DailyEvent | null {
  const { bucket, doc } = row;
  const raw = doc[def.dateField];
  if (!raw || typeof doc.__dayKey !== 'string') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const date: string = doc.__dayKey;
  const allDay = def.dateRule === 'date' || (def.dateRule === 'instantOrMidnight' && isServerMidnight(at));
  const statusValue = doc[def.status.field];
  const open = !(typeof statusValue === 'string' && stages.terminal.has(statusValue)) && (def.isOpen?.(doc) ?? true);
  const parts = def.toEvent(doc, names);
  const kind = def.kind(bucket, doc, { now: windows.now, open });
  const endTime = !allDay && parts.endAt && localDateKey(new Date(parts.endAt), windows.timezone) === date
    ? localTime(new Date(parts.endAt), windows.timezone)
    : undefined;
  return {
    id: `${def.source}:${def.module}:${String(doc._id)}`,
    source: def.source,
    module: def.module,
    moduleLabel: def.label,
    category: def.category,
    bucket,
    title: parts.title,
    subtitle: parts.subtitle,
    kind,
    date,
    time: allDay ? undefined : localTime(at, windows.timezone),
    endTime,
    allDay,
    at: at.toISOString(),
    status: statusOf(statusValue, stages, bucket, kind === 'SLA breached'),
    related: parts.related,
    // Same rule as the lead section's follow-up counts: an open meeting, call,
    // task or activity linked to a lead.
    leadFollowUp: open && (LEAD_FOLLOW_UP_MODULES as readonly string[]).includes(def.module) && isLeadRelated(doc.relatedModule),
    assignee: parts.assignee,
    link: parts.link,
  };
}

/** Customer and staff names, looked up once — only when the caller may see
 * those modules themselves; otherwise (or if a lookup fails) the business id
 * is shown. Names are cosmetic, so a failure here never fails the view. */
async function buildNameLookups(tenantId: string, gates: Gates, customerIds: Set<string>, staffIds: Set<string>): Promise<NameLookups> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const canSee = (g: { flag: string; permission: string }) => !gates.flagOff(g.flag) && gates.allowed(g.permission);
  const customers = new Map<string, string>();
  const staff = new Map<string, string>();

  const safely = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      logger.warn('Daily events: name lookup failed, showing ids', { tenantId, what, error: (err as Error).message });
    }
  };
  await Promise.all([
    canSee(LOOKUP_GATES.customer) && customerIds.size ? safely('customers', async () => {
      const docs = await NativeCustomer.find({ tenantId: tid, customerId: { $in: Array.from(customerIds) } }).select('customerId name').lean();
      for (const d of docs as any[]) if (d.customerId && d.name) customers.set(d.customerId, d.name);
    }) : null,
    canSee(LOOKUP_GATES.staff) && staffIds.size ? safely('staff', async () => {
      const docs = await NativeStaff.find({ tenantId: tid, staffId: { $in: Array.from(staffIds) } }).select('staffId firstName lastName').lean();
      for (const d of docs as any[]) {
        const name = [d.firstName, d.lastName].filter(Boolean).join(' ').trim();
        if (d.staffId && name) staff.set(d.staffId, name);
      }
    }) : null,
  ]);

  return {
    customer: (id) => (typeof id === 'string' ? customers.get(id) : undefined),
    staff: (id) => (typeof id === 'string' ? staff.get(id) : undefined),
  };
}

function collectIds(target: Set<string>, values: unknown[] | undefined): void {
  for (const v of values ?? []) if (typeof v === 'string' && v.trim()) target.add(v.trim());
}

/* ── Contract visits ────────────────────────────────────────────────────── */

interface VisitRow { bucket: 'today' | 'upcoming'; contract: any; visit: any; key: string }

/** Service visits of ACTIVE contracts for today and the next 7 days (same
 * branch + DataScope as Contracts). One aggregation: visits are unwound,
 * keyed by calendar day like any date-only field (they are server-local
 * midnights), and counted exactly. */
async function fetchContractVisits(ctx: DailyEventsContext, gates: Gates, windows: DayWindows) {
  const stages = await peekStages(ctx.tenantId, 'contract');
  const activeKeys = stages.filter((s) => s.outcome === 'active').map((s) => s.key);
  if (!activeKeys.length) activeKeys.push('active');

  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(ctx.tenantId), status: { $in: activeKeys } };
  if (ctx.branchId) filter.branchId = new mongoose.Types.ObjectId(ctx.branchId);
  applyDataScopeToFilter(filter, gates.scopeFor(CONTRACT_VISITS.scopeKey), 'staffIds');
  const range = coarseRange('upcoming', windows);
  range.$gte = new Date(keyStartUtc(windows.todayKey).getTime() - DAY_MS);
  const visitFields = { title: 1, contractId: 1, customerId: 1, visits: 1, __dayKey: 1 };

  const [result] = await NativeContract.aggregate([
    { $match: { ...filter, 'visits.serviceDate': range } },
    { $unwind: '$visits' },
    { $match: { 'visits.serviceDate': range } },
    { $addFields: { __dayKey: dayKeyExpression('visits.serviceDate', 'date', windows.timezone) } },
    // Today shows every visit; upcoming only visits still to happen.
    {
      $match: {
        $or: [
          { __dayKey: windows.todayKey },
          { __dayKey: { $gt: windows.todayKey, $lte: windows.upcomingEndKey }, 'visits.status': { $in: CONTRACT_VISITS.open } },
        ],
      },
    },
    {
      $facet: {
        todayTotal: [{ $match: { __dayKey: windows.todayKey } }, { $count: 'n' }],
        upcomingTotal: [{ $match: { __dayKey: { $gt: windows.todayKey } } }, { $count: 'n' }],
        todayItems: [
          { $match: { __dayKey: windows.todayKey } },
          { $sort: { 'visits.visitNumber': 1, _id: 1 } },
          { $limit: VISIT_LIMITS.today },
          { $project: visitFields },
        ],
        upcomingItems: [
          { $match: { __dayKey: { $gt: windows.todayKey } } },
          { $sort: { __dayKey: 1, 'visits.visitNumber': 1, _id: 1 } },
          { $limit: VISIT_LIMITS.upcoming },
          { $project: visitFields },
        ],
      },
    },
  ]);

  const toRows = (items: any[] | undefined, bucket: VisitRow['bucket']): VisitRow[] =>
    (items ?? []).map((d) => ({ bucket, contract: d, visit: d.visits, key: d.__dayKey }));
  const counts = { ...EMPTY_COUNTS(), today: result?.todayTotal?.[0]?.n ?? 0, upcoming: result?.upcomingTotal?.[0]?.n ?? 0 };
  const todayRows = toRows(result?.todayItems, 'today');
  const upcomingRows = toRows(result?.upcomingItems, 'upcoming');
  return {
    counts,
    rows: [...todayRows, ...upcomingRows],
    truncated: { today: todayRows.length < counts.today, overdue: false, upcoming: upcomingRows.length < counts.upcoming },
  };
}

function contractVisitEvent(row: VisitRow, names: NameLookups): DailyEvent {
  const { bucket, contract, visit, key } = row;
  const status = typeof visit.status === 'string' ? visit.status : '';
  const customer = names.customer(contract.customerId) ?? (typeof contract.customerId === 'string' ? contract.customerId : undefined);
  const name = contract.title ?? contract.contractId ?? 'Contract';
  return {
    id: `field_service:contract_visit:${String(contract._id)}:${visit.visitNumber ?? key}`,
    source: 'field_service',
    module: CONTRACT_VISITS.module,
    moduleLabel: CONTRACT_VISITS.label,
    category: 'contract',
    bucket,
    title: visit.visitNumber != null ? `Visit ${visit.visitNumber} · ${name}` : `Visit · ${name}`,
    subtitle: [contract.contractId, customer].filter(Boolean).join(' · ') || undefined,
    kind: 'Service visit',
    date: key,
    allDay: true,
    at: `${key}T00:00:00.000Z`,
    status: status ? {
      key: status,
      label: humanise(status),
      tone: CONTRACT_VISITS.cancelled.includes(status) ? 'cancelled' : CONTRACT_VISITS.open.includes(status) ? 'open' : 'done',
    } : undefined,
    leadFollowUp: false,
    link: { path: `/native-crm/contracts/${String(contract._id)}`, exact: true },
  };
}

/* ── Summaries ──────────────────────────────────────────────────────────── */

function moduleSummary(
  def: { module: string; label: string; category: DailyEventsModuleSummary['category']; buckets: DailyEventBucket[]; note?: string },
  status: DailyEventModuleStatus,
  extra?: Partial<DailyEventsModuleSummary>,
): DailyEventsModuleSummary {
  return { module: def.module, label: def.label, category: def.category, status, buckets: def.buckets, ...(def.note ? { note: def.note } : {}), ...extra };
}

function sumCounts(modules: DailyEventsModuleSummary[]): DailyEventCounts {
  const total = EMPTY_COUNTS();
  for (const m of modules) {
    if (m.status !== 'ok' || !m.counts) continue;
    total.today += m.counts.today;
    total.overdue += m.counts.overdue;
    total.upcoming += m.counts.upcoming;
  }
  return total;
}

function capPerSection(events: DailyEvent[]): { kept: DailyEvent[]; truncated: { today: boolean; overdue: boolean; upcoming: boolean } } {
  const seen: Record<DailyEventBucket, number> = { today: 0, overdue: 0, upcoming: 0 };
  const truncated = { today: false, overdue: false, upcoming: false };
  const kept: DailyEvent[] = [];
  for (const e of events) {
    if (seen[e.bucket] >= SECTION_LIMITS[e.bucket]) { truncated[e.bucket] = true; continue; }
    seen[e.bucket] += 1;
    kept.push(e);
  }
  return { kept, truncated };
}

/* ── Connectors ─────────────────────────────────────────────────────────── */

/** Connector sources: one per active CRM connector type, each read only
 * from its own synced records and never merged with built-in data. A
 * source (and its sync status) appears only to someone who could open its
 * data elsewhere: the connector flag is on, and they can view at least one
 * of its modules or the Connectors screen. */
async function buildConnectorSources(ctx: DailyEventsContext, gates: Gates, windows: DayWindows): Promise<{ sources: DailyEventsSource[]; events: DailyEvent[] }> {
  const tid = new mongoose.Types.ObjectId(ctx.tenantId);
  const connectors = await Connector.find({ tenantId: tid, isActive: true, type: { $in: Object.keys(CONNECTOR_EVENT_MODULES) } })
    .select('type syncStatus lastSyncAt').lean() as any[];

  // CRMRecord is keyed by connector type, so two active connectors of one
  // type share one source; the least healthy sync state wins.
  const byType = new Map<string, { syncStatus: string; lastSyncAt: Date | null }>();
  const RANK: Record<string, number> = { failed: 3, syncing: 2, idle: 1, success: 0 };
  for (const c of connectors) {
    const prev = byType.get(c.type);
    const last = c.lastSyncAt ? new Date(c.lastSyncAt) : null;
    if (!prev) { byType.set(c.type, { syncStatus: c.syncStatus ?? 'idle', lastSyncAt: last }); continue; }
    if ((RANK[c.syncStatus] ?? 0) > (RANK[prev.syncStatus] ?? 0)) prev.syncStatus = c.syncStatus;
    if (last && (!prev.lastSyncAt || last > prev.lastSyncAt)) prev.lastSyncAt = last;
  }

  const canSeeConnectorsScreen = gates.allowed('connector.view') && !gates.flagOff('nav_connectors');
  const sources: DailyEventsSource[] = [];
  const allEvents: DailyEvent[] = [];
  for (const type of Array.from(byType.keys()).sort()) {
    if (gates.flagOff(`connector_${type}`)) continue;
    const defs = CONNECTOR_EVENT_MODULES[type];
    const allowed = defs.filter((def) => gates.allowed(`connector.${type}.${def.module.toLowerCase()}.view`));
    if (!allowed.length && !canSeeConnectorsScreen) continue;
    const sync = byType.get(type)!;

    const modules = await Promise.all(defs.map(async (def) => {
      const base = { module: def.module, label: def.label, category: def.category, buckets: (def.closure ? ['today', 'overdue', 'upcoming'] : ['today', 'upcoming']) as DailyEventBucket[] };
      if (!allowed.includes(def)) return { summary: moduleSummary(base, 'no_permission'), events: [] as DailyEvent[] };
      try {
        // Newest first: if the limit is ever reached, recent records are the ones read.
        const records = await CRMRecord.find({ tenantId: tid, channel: type, module: def.module })
          .select(connectorProjection(def)).sort({ _id: -1 }).limit(CONNECTOR_SCAN_LIMIT + 1).lean() as any[];
        if (!records.length) return { summary: moduleSummary(base, 'not_synced'), events: [] as DailyEvent[] };
        const incomplete = records.length > CONNECTOR_SCAN_LIMIT;
        const extraction = extractConnectorEvents(type, def, records.slice(0, CONNECTOR_SCAN_LIMIT), windows);
        if (extraction.dated === 0) {
          return {
            summary: moduleSummary(base, 'no_dates', { note: `The synced records carry none of the date fields Daily Events reads (${def.date.join(', ')}).` }),
            events: [] as DailyEvent[],
          };
        }
        const { kept, truncated } = capPerSection(extraction.events);
        return {
          summary: moduleSummary(base, 'ok', {
            counts: extraction.counts,
            truncated,
            ...(incomplete ? { incomplete: true, note: `Only the newest ${CONNECTOR_SCAN_LIMIT.toLocaleString('en-US')} synced records were checked.` } : {}),
          }),
          events: kept,
        };
      } catch (err) {
        logger.warn('Daily events: connector module read failed', { tenantId: ctx.tenantId, type, module: def.module, error: (err as Error).message });
        return { summary: moduleSummary(base, 'error'), events: [] as DailyEvent[] };
      }
    }));

    const summaries = modules.map((m) => m.summary);
    sources.push({
      key: `connector:${type}`,
      label: CONNECTOR_LABELS[type] ?? humanise(type),
      kind: 'connector',
      counts: sumCounts(summaries),
      partial: summaries.some((m) => m.status === 'error'),
      modules: summaries,
      connector: { type, syncStatus: sync.syncStatus, lastSyncAt: sync.lastSyncAt ? sync.lastSyncAt.toISOString() : null },
    });
    for (const m of modules) allEvents.push(...m.events);
  }
  return { sources, events: allEvents };
}

/* ── The view ───────────────────────────────────────────────────────────── */

/** GET /api/v1/daily-events. Strictly read-only: every query is a lean find
 * or an aggregation; nothing is created, updated, sent or queued, and no AI
 * service is called. */
export async function buildDailyEvents(ctx: DailyEventsContext): Promise<DailyEventsResponse> {
  const tenant = await Tenant.findById(ctx.tenantId).select('settings.timezone').lean() as any;
  const windows = buildDayWindows(tenant?.settings?.timezone, ctx.now ?? new Date());
  const gates = await buildGates(ctx);
  const stageCache = new Map<string, Promise<StageInfo>>();

  // 1. Gate and fetch every built-in module; one failure never hides the others.
  const fetched = await mapWithConcurrency(RECORD_SOURCES, MODULE_CONCURRENCY, async (def) => {
    if (gates.flagOff(def.flag)) return { def, status: 'disabled' as const };
    if (!gates.allowed(def.permission)) return { def, status: 'no_permission' as const };
    // Without a resolved DataScope nothing can be read safely: say so, never "0".
    if (ctx.dataScopeFailed) return { def, status: 'error' as const };
    try {
      return { def, status: 'ok' as const, data: await fetchRecordSource(def, ctx, gates, windows, stageCache) };
    } catch (err) {
      logger.warn('Daily events: module read failed', { tenantId: ctx.tenantId, module: def.module, error: (err as Error).message });
      return { def, status: 'error' as const };
    }
  });

  const contractsVisible = !gates.flagOff(CONTRACT_VISITS.flag) && gates.allowed(CONTRACT_VISITS.permission);
  let visits: Awaited<ReturnType<typeof fetchContractVisits>> | null = null;
  let visitsFailed = !!ctx.dataScopeFailed;
  if (contractsVisible && !visitsFailed) {
    try {
      visits = await fetchContractVisits(ctx, gates, windows);
    } catch (err) {
      visitsFailed = true;
      logger.warn('Daily events: contract visits read failed', { tenantId: ctx.tenantId, error: (err as Error).message });
    }
  }

  // 2. Resolve customer / staff names in one pass.
  const customerIds = new Set<string>();
  const staffIds = new Set<string>();
  for (const f of fetched) {
    if (f.status !== 'ok') continue;
    for (const row of f.data.rows) {
      collectIds(customerIds, f.def.customerIds?.(row.doc));
      collectIds(staffIds, f.def.staffIds?.(row.doc));
    }
  }
  for (const row of visits?.rows ?? []) collectIds(customerIds, [row.contract.customerId]);
  const names = await buildNameLookups(ctx.tenantId, gates, customerIds, staffIds);

  // 3. Build events and per-source summaries.
  const events: DailyEvent[] = [];
  const summaries: Record<'native_crm' | 'field_service', DailyEventsModuleSummary[]> = { native_crm: [], field_service: [] };

  const pushContractVisits = (list: DailyEventsModuleSummary[]) => {
    if (!contractsVisible) {
      list.push(moduleSummary(CONTRACT_VISITS, gates.flagOff(CONTRACT_VISITS.flag) ? 'disabled' : 'no_permission'));
      return;
    }
    if (visitsFailed || !visits) { list.push(moduleSummary(CONTRACT_VISITS, 'error')); return; }
    events.push(...visits.rows.map((row) => contractVisitEvent(row, names)));
    list.push(moduleSummary(CONTRACT_VISITS, 'ok', { counts: visits.counts, truncated: visits.truncated }));
  };

  for (const f of fetched) {
    const list = summaries[f.def.source];
    if (f.status !== 'ok') {
      list.push(moduleSummary(f.def, f.status));
    } else {
      for (const row of f.data.rows) {
        const event = recordEvent(f.def, row, f.data.stages, names, windows);
        if (event) events.push(event);
      }
      list.push(moduleSummary(f.def, 'ok', { counts: f.data.counts, truncated: f.data.truncated }));
    }
    // Contract visits are listed right after contract end dates.
    if (f.def.module === 'contract') pushContractVisits(list);
  }

  const nativeSources: DailyEventsSource[] = (['native_crm', 'field_service'] as const).map((key) => ({
    key,
    label: key === 'native_crm' ? 'Native CRM' : 'Field Service',
    kind: 'native',
    counts: sumCounts(summaries[key]),
    partial: summaries[key].some((m) => m.status === 'error'),
    modules: summaries[key],
  }));

  // 4. Connectors — a failure here never hides built-in data.
  let connectorPart: { sources: DailyEventsSource[]; events: DailyEvent[] } = { sources: [], events: [] };
  try {
    connectorPart = await buildConnectorSources(ctx, gates, windows);
  } catch (err) {
    logger.warn('Daily events: connector list failed', { tenantId: ctx.tenantId, error: (err as Error).message });
    if (gates.anyConnectorAccess) {
      connectorPart = {
        sources: [{ key: 'connector:unavailable', label: 'Connected CRMs', kind: 'connector', counts: EMPTY_COUNTS(), partial: true, unavailable: true, modules: [] }],
        events: [],
      };
    }
  }

  // 5. Lead activity & conversion — its own section; a failure never hides the rest.
  let leads: LeadInsights;
  let staleDays = DEFAULT_STALE_LEAD_DAYS;
  try {
    staleDays = (await getCrmAssistantSettings(ctx.tenantId)).staleLeadDays;
    leads = await buildLeadInsights(ctx, gates, windows, staleDays, stageCache);
  } catch (err) {
    logger.warn('Daily events: lead insights failed', { tenantId: ctx.tenantId, error: (err as Error).message });
    leads = { source: 'field_service', status: 'error', staleDays, stages: [], followUpModules: [], followUpFailed: [] };
  }

  // 6. One list, ordered by section then calendar date and time; ids are unique by construction.
  const seen = new Set<string>();
  const all = [...events, ...connectorPart.events].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  all.sort(compareEvents);

  return {
    date: windows.todayKey,
    timezone: windows.timezone,
    timezoneFallback: windows.timezoneFallback,
    generatedAt: windows.now.toISOString(),
    upcomingThrough: windows.upcomingEndKey,
    sources: [...nativeSources, ...connectorPart.sources],
    events: all,
    notIncluded: NOT_INCLUDED,
    leads,
  };
}

/* ── Short per-user cache ───────────────────────────────────────────────── */

/** The panel refreshes on a timer and on demand; a short per-user cache and
 * one shared in-flight read keep repeated opens from re-running every query.
 * Keyed by everything that shapes the result for this caller. */
const CACHE_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; data: DailyEventsResponse }>();
const inFlight = new Map<string, Promise<DailyEventsResponse>>();
/** Bumped when a tenant's settings change, so a read already running keeps
 * its result out of the cache. */
const tenantGeneration = new Map<string, number>();

function cacheKey(ctx: DailyEventsContext): string {
  return [ctx.tenantId, ctx.userId, ctx.role, ctx.roleId ?? '', ctx.branchId ?? '', ctx.dataScopeFailed ? 'scope-failed' : ''].join('|');
}

/** Empties the cache (tests). */
export function clearDailyEventsCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Drops a tenant's cached views (this server process) after a setting that
 * shapes them, such as "stuck after N days", is saved. */
export function invalidateDailyEventsForTenant(tenantId: string): void {
  tenantGeneration.set(tenantId, (tenantGeneration.get(tenantId) ?? 0) + 1);
  const prefix = `${tenantId}|`;
  for (const key of Array.from(cache.keys())) if (key.startsWith(prefix)) cache.delete(key);
  for (const key of Array.from(inFlight.keys())) if (key.startsWith(prefix)) inFlight.delete(key);
}

/** buildDailyEvents behind the short cache; `fresh` skips the cached copy. */
export async function getDailyEvents(ctx: DailyEventsContext, opts: { fresh?: boolean } = {}): Promise<DailyEventsResponse> {
  const key = cacheKey(ctx);
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const running = inFlight.get(key);
  if (running) return running;

  const generation = tenantGeneration.get(ctx.tenantId) ?? 0;
  const promise: Promise<DailyEventsResponse> = buildDailyEvents(ctx)
    .then((data) => {
      if ((tenantGeneration.get(ctx.tenantId) ?? 0) === generation) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), data });
        while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      }
      return data;
    })
    .finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}
