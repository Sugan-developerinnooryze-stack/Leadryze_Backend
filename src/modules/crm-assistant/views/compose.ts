import { randomUUID } from 'crypto';
import type { FieldCap, ModuleCap } from '../registry/types';
import { getModuleCap } from '../registry';
import { SOURCE_LABELS } from '../registry/labels';
import { listLinkFor, recordLinkFor } from '../contracts/routes';
import {
  Cell, ClarifyBlock, ClarifyOption, Column, DataTableBlock, FilterChip, KpiGroupBlock, KpiItem, NoticeBlock, OperationConfirmationSchema, QueryHandle,
  RecordAction, RecordDetailBlock, Row, SectionState, SourceGroupBlock, SourceRef, ViewActionRequestSchema, ViewBlock, VIEWS_VERSION, VIEW_CAPS,
  validateViews,
} from '../contracts/views';
import { AssistSessionState, AssistSessionStateSchema, QueryPlan } from '../contracts/plan';
import type { AnswerPath, ResolveResult } from '../contracts/api';
import type { ModuleAccess } from '../capability-view';
import type { ListOutcome, ReadContext, StatusInfo } from '../query/execute-list';
import type { ImpliedCondition } from '../query/compile';
import type { GroupRow, PartialReason, QueryNotice } from '../query/execute-query';
import type { MetricOutcome, MetricRow } from '../query/metrics';
import type { RelationOutcome } from '../query/relations';
import type { DetailExtrasData, DetailLine, RelatedCount } from '../query/detail';
import { MineUnavailableError, mineLabel } from '../query/mine';
import type { SourceCountSection } from '../query/source-counts';
import type { ConnectorCountSection } from '../query/connector-counts';
import { CONCEPTS, ConceptKey } from '../registry/concepts';
import {
  CONNECTOR_CONCEPT_MODULES, CONNECTOR_TYPE_LABELS, ConnectorConcept, ConnectorType, normaliseModuleName,
} from '../registry/connectors';
import { isQuerySortable, queryCapsFor } from '../registry/query-caps';
import { DEFAULT_LIST_LIMIT } from '../../internal/crm-gateway.helpers';
import { PII_FIELDS } from '../../../platform/pii/constants';
import { buildDayWindows, dayKeyFor, localTime, utcDateKey } from '../../daily-events/daily-events.time';
import { RECORD_SOURCES } from '../../daily-events/daily-events.sources';
import { logger } from '../../../utils/logger';
import { DEFAULT_SOURCE, cellText, fallbackText, hasData, scrubIds, sourceBadge } from './fallback-text';
import { ChipContext, RelationWords, askedRelationPhrase, conditionPhrases, filterChips } from './chips';
import {
  ScopeKind, groupLabel, interpretConcept, interpretMetric, interpretPlan, lowerLabel, partialMineWords, recordsPhrase, scopeNoteFor,
  sentenceCase, summaries,
} from './interpret';
import { composeEntityChoices, composeParentChoices } from './clarify';

/* Turns executor results into view blocks (contracts/views.ts), the
 * fallback text, the badge, the history summary and the next session
 * state. Every reply is checked with validateViews before it leaves: a
 * block that fails is dropped, logged and replaced by a notice (fail
 * closed). Text shown to people never carries a record id.
 *
 * Increment 5: a relation's chip, words and partial state on tables, counts
 * and breakdowns (QueryRun.relation); the answer to a relation that can't
 * run as asked (composeRelationOutcome); named totals (composeMetric); record
 * cards with their lines, stored totals and related counts (composeDetail);
 * records sharing a number as a choice of each (composeDuplicates).
 *
 * Increment 6: the session's open guided form (ComposedAnswer.operationId)
 * is kept in the next state, and a review card's confirmation is passed on
 * to the answer; a record card can carry Edit and Delete actions.
 *
 * Increment 8: the small helpers are exported for the chart, pipeline and
 * agenda composers (views/chart.ts, pipeline.ts, agenda.ts); a named total's
 * table is metricTable (also under its charts); a due-today or overdue list
 * of a Daily Events module offers "Open Daily Events" while the switch is on. */

export type AnswerResult = Extract<ResolveResult, { kind: 'answer' }>;

export interface ComposeEnv {
  /** Tenant timezone, for calendar dates. */
  timezone: string;
  /** The caller's effective scope for this module. */
  scopeKind: ScopeKind;
  /** Whether the caller may open another module's pages (for reference links). */
  canViewModule: (module: string) => boolean;
  /** Increment 8: the tenant's Daily Events switch for this caller, asked only for a list that could offer it. */
  dailyEventsOn?: boolean;
}

export interface ComposedAnswer {
  blocks: ViewBlock[];
  summary: string;
  interpretedAs?: string;
  /** The plan that ran, kept as the session's lastPlan. */
  plan?: QueryPlan;
  /** The record shown, kept as the session's focus. */
  focus?: { module: string; id: string };
  /** False when no record data was read (greetings, help, refusals). */
  dataRead: boolean;
  /** Increment 6: the session's open operation after this answer. A string
   * sets it, null clears it, absent keeps it. */
  operationId?: string | null;
  /** Increment 6: set only when the answer shows a review card (a delete
   * started from chat, or "review" typed): what Confirm sends back. */
  confirmation?: { operationId: string; revision: number; payloadHash: string; expiresAt: string; summary: string };
}

/** How a table or a count ran: the executor its handle re-runs on (an L
 * table's sort is re-run on Q; anything else stays on its own executor), and
 * what executor Q reports besides rows. */
export interface QueryRun {
  executor: 'L' | 'Q';
  /** The sort that ran (executor Q always reports one). */
  sort?: { by: string; dir: 'asc' | 'desc' };
  /** Conditions the engine added on its own: chips that can't be removed. */
  implied?: readonly ImpliedCondition[];
  /** Executor Q's notes ("2 deals in other currencies were not compared."). */
  notices?: readonly QueryNotice[];
  /** False when this caller can't rank Field Service amounts (no branch
   * picked and the tenant's companies use more than one currency): those
   * money columns are then not offered for sorting. Absent = rankable. */
  fsRankable?: boolean;
  /** What the plan's relation adds (views/chips.ts relationWords): its chip
   * ("rel"), its words, and why the answer is partial. */
  relation?: RelationWords;
}

const L_RUN: QueryRun = { executor: 'L' };

/** The id of a list answer's table (composeTable); its notes are `${TABLE_BLOCK_ID}-n<i>`. */
const TABLE_BLOCK_ID = 'b1-t';

const MAX_TABLE_COLUMNS = VIEW_CAPS.columns;
const MAX_DETAIL_FIELDS = 40;
const HEX_ID = /^[a-f0-9]{24}$/i;
const MAX_LAST_PLAN_CHARS = 600;

/* ── Small helpers ─────────────────────────────────────────────────────── */

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function topLevel(path: string): string {
  return path.split('.')[0];
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), record);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && !(value as { _bsontype?: unknown })._bsontype;
}

export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** Readable text, or null: ids are removed, objects are not text. */
export function textValue(value: unknown, max = 300): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => textValue(v, max)).filter((v): v is string => !!v);
    return parts.length ? clip(parts.join(', '), max) : null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = scrubIds(String(value));
    return s ? clip(s, max) : null;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function'
    && (value as { _bsontype?: unknown })._bsontype === 'Decimal128') {
    const n = Number(String(value));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function idOf(record: Record<string, unknown>): string | null {
  const raw = record._id;
  if (raw === null || raw === undefined) return null;
  const id = String(raw);
  return HEX_ID.test(id) ? id : null;
}

/* ── Source, columns and cells ─────────────────────────────────────────── */

export function sourceRefFor(cap: ModuleCap, scopeKind: ScopeKind): SourceRef {
  const note = scopeNoteFor(cap, scopeKind);
  return {
    key: cap.group,
    label: SOURCE_LABELS[cap.group],
    module: cap.key,
    moduleLabel: cap.labels.plural,
    scope: scopeKind === 'all' ? 'all' : 'visible_to_you',
    ...(note ? { scopeNote: clip(note, 200) } : {}),
  };
}

function isPiiField(cap: ModuleCap, field: FieldCap): boolean {
  if (field.pii) return true;
  const def = PII_FIELDS[cap.gate.scopeKey];
  const key = topLevel(field.path);
  return !!def && (def.level2.includes(key) || def.level3.includes(key));
}

/** A field may be shown only when the gateway's own read projection
 * returns it (so the engine never shows more than /crm-list or /crm-get). */
function isShowable(field: FieldCap, read: ReadContext): boolean {
  return field.read !== 'hidden' && field.kind !== 'line_items' && read.allowedKeys.has(topLevel(field.path));
}

export function isStatusField(field: FieldCap, status: StatusInfo | null): boolean {
  return field.kind === 'stage' || (!!status && (field.path === status.field || field.key === status.field));
}

function columnKind(cap: ModuleCap, field: FieldCap, read: ReadContext): Column['kind'] {
  if (isPiiField(cap, field) && !read.piiVisible) return 'masked';
  if (isStatusField(field, read.status)) return 'status';
  switch (field.kind) {
    case 'number': case 'percent': case 'duration': return 'number';
    case 'money': return 'money';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'boolean': return 'bool';
    case 'ref': return 'ref';
    default: return 'text';
  }
}

/** `isSortable` says which columns the table's own executor can sort by
 * (sortableOn); without it no column is sortable. */
export function tableColumns(
  cap: ModuleCap, read: ReadContext, isSortable: (field: FieldCap) => boolean = () => false,
): Array<{ field: FieldCap; column: Column }> {
  return cap.fields
    .map((field, order) => ({ field, order }))
    .filter(({ field }) => field.read === 'list' && field.priority !== undefined && isShowable(field, read))
    .sort((a, b) => (a.field.priority! - b.field.priority!) || (a.order - b.order))
    .slice(0, MAX_TABLE_COLUMNS)
    .map(({ field }) => {
      const kind = columnKind(cap, field, read);
      return {
        field,
        column: {
          key: field.key, label: clip(field.label, 120), kind,
          align: kind === 'number' || kind === 'money' ? 'right' : 'left',
          sortable: isSortable(field),
          priority: field.priority!,
        },
      };
    });
}

/** The sort key a view action may send (ViewActionRequestSchema): a column
 * whose key doesn't fit it could never be sorted from the browser, so it is
 * never offered as sortable. */
const SortKeySchema = ViewActionRequestSchema.shape.sort.unwrap().shape.key;
const fitsSortKey = (key: string): boolean => SortKeySchema.safeParse(key).success;

/** What a table's handle can be sorted by. Every sort runs on executor Q
 * (its _id tie-break keeps pages stable; list() sorts have none, and Q ranks
 * amounts one currency at a time), and an executor L table's sort is re-run
 * on Q, which reads the same records: so on both executors, any field Q can
 * sort by (isQuerySortable), except Field Service amounts this caller can't
 * rank (fsRankable false: no branch picked and the tenant's companies use
 * several currencies). An L table that searches by text offers no sort at
 * all: list() and Q search differently, so it is never re-run on Q. */
export function sortableOn(
  cap: ModuleCap, plan: QueryPlan, executor: 'L' | 'Q', fsRankable = true,
): (field: FieldCap) => boolean {
  if (!queryCapsFor(cap.key)?.q) return () => false;
  if (executor === 'L' && plan.search?.trim()) return () => false;
  return (field) => fitsSortKey(field.key) && isQuerySortable(cap, field)
    && (fsRankable || !(field.kind === 'money' && field.money?.currency === 'fs_branch'));
}

/** How long an executor L table waits, at most, to learn whether its Field
 * Service amounts can be sorted (fsRankableOnL). Tests change `ms`. */
export const FS_RANKABLE_BUDGET = { ms: 400 };

/** QueryRun.fsRankable for an executor L table (executor Q reports its own).
 * It only matters for a table with a Field Service amount column it could
 * otherwise be sorted by; only then is `rankable` asked (executor Q's own
 * rule, execute-query.ts fsAmountsRankable: a branch picked, or one currency
 * across the tenant's companies), for at most `budgetMs`. A failure, or no
 * answer by then, counts as not rankable: the column is just not offered for
 * sorting, so this read never holds up or drops the table. */
export async function fsRankableOnL(
  cap: ModuleCap, plan: QueryPlan, rankable: () => Promise<boolean>, budgetMs: number = FS_RANKABLE_BUDGET.ms,
): Promise<boolean> {
  // A searched L table offers no sort at all (sortableOn).
  if (plan.search?.trim() || !queryCapsFor(cap.key)?.q) return true;
  const amountColumn = cap.fields.some((f) => f.read === 'list' && f.priority !== undefined
    && f.kind === 'money' && f.money?.currency === 'fs_branch' && isQuerySortable(cap, f));
  if (!amountColumn) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('CRM assist: Field Service currencies not read in time; amounts not offered for sorting', { module: cap.key, budgetMs });
      resolve(false);
    }, Math.max(0, budgetMs));
    // The first answer counts; a late one (or a late failure) is dropped.
    const settle = (rankableNow: boolean) => { clearTimeout(timer); resolve(rankableNow); };
    try {
      rankable().then(settle, () => settle(false));
    } catch {
      settle(false);
    }
  });
}

export function statusCell(raw: unknown, status: StatusInfo | null): Cell {
  if (typeof raw !== 'string' || !raw) return { t: 'text', v: null };
  const option = status?.options.get(raw);
  return {
    t: 'status',
    key: clip(raw, 80),
    label: clip(option?.label ?? humanize(raw), 120),
    ...(option?.color ? { color: clip(option.color, 16) } : {}),
    tone: option?.tone ?? 'unknown',
  };
}

function refCell(field: FieldCap, raw: unknown, env: ComposeEnv): Cell {
  const target = field.ref?.module;
  const href = target && env.canViewModule(target) ? listLinkFor(target) : undefined;
  if (isPlainObject(raw)) {
    const label = textValue(raw.name ?? raw.title ?? [raw.firstName, raw.lastName].filter(Boolean).join(' '), 200);
    return label ? { t: 'ref', label, ...(href ? { href } : {}) } : { t: 'text', v: null };
  }
  if (typeof raw !== 'string' || !raw || HEX_ID.test(raw)) return { t: 'text', v: null };
  const label = textValue(raw, 200);
  if (!label) return { t: 'text', v: null };
  // The stored value is the business number itself, so it is the label; a
  // separate `number` would only repeat it ("9A218C-CUS-0008 9A218C-CUS-0008").
  return { t: 'ref', label, ...(href ? { href } : {}) };
}

/** The calendar day a date field shows: the UTC day of a value stored at
 * 23:59:59.999 UTC on the day picked (FieldCap.endOfDayUtc: the contract's end
 * date, which the form shows as that day); anything else as its dateRule reads it. */
function shownDayOf(field: FieldCap, d: Date, timezone: string): string {
  const endOfUtcDay = d.getUTCHours() === 23 && d.getUTCMinutes() === 59 && d.getUTCSeconds() === 59 && d.getUTCMilliseconds() === 999;
  return field.endOfDayUtc && endOfUtcDay ? utcDateKey(d) : dayKeyFor(d, field.dateRule ?? 'date', timezone).key;
}

export function cellFor(
  cap: ModuleCap, field: FieldCap, record: Record<string, unknown>, read: ReadContext, env: ComposeEnv,
): Cell {
  const raw = getPath(record, field.path);
  if (isPiiField(cap, field) && !read.piiVisible) {
    const shown = textValue(raw, 80);
    return shown ? { t: 'masked', display: shown } : { t: 'text', v: null };
  }
  if (isStatusField(field, read.status)) return statusCell(raw, read.status);
  switch (field.kind) {
    case 'number':
    case 'percent':
    case 'duration': {
      let v = toNumber(raw);
      let unit: 'minutes' | 'hours' | 'percent' | undefined;
      if (field.kind === 'percent') unit = 'percent';
      else if (field.kind === 'duration') {
        if (field.unit === 'seconds' && v !== null) { v = Math.round((v / 60) * 10) / 10; unit = 'minutes'; } else unit = field.unit === 'hours' ? 'hours' : field.unit === 'minutes' ? 'minutes' : undefined;
      }
      return { t: 'number', v, ...(unit ? { unit } : {}) };
    }
    case 'money': {
      const spec = field.money?.currency;
      // A Field Service amount is in its own record's company currency where the
      // list knows it (ReadContext.recordCurrency), else in the caller's.
      const id = record._id === null || record._id === undefined ? undefined : String(record._id);
      const currency = spec === 'fs_branch' ? (id !== undefined ? read.recordCurrency?.get(id) : undefined) ?? read.currency
        : spec && typeof spec === 'object' ? textValue(getPath(record, spec.field), 8)
          : null;
      return { t: 'money', v: toNumber(raw), currency: currency ? clip(currency, 8) : null };
    }
    case 'date': {
      const d = toDate(raw);
      return { t: 'date', v: d ? shownDayOf(field, d, env.timezone) : null };
    }
    case 'datetime': {
      const d = toDate(raw);
      if (!d) return { t: 'datetime', v: null, tz: clip(env.timezone, 64) };
      // A date-only value (the module's own all-day rule) is a calendar day.
      const day = dayKeyFor(d, field.dateRule ?? 'instant', env.timezone);
      return day.allDay ? { t: 'date', v: day.key } : { t: 'datetime', v: d.toISOString(), tz: clip(env.timezone, 64) };
    }
    case 'boolean':
      return { t: 'bool', v: typeof raw === 'boolean' ? raw : null };
    case 'enum':
      return { t: 'text', v: typeof raw === 'string' && raw ? clip(humanize(raw), 300) : null };
    case 'ref':
      return refCell(field, raw, env);
    case 'ref_many':
      return { t: 'text', v: Array.isArray(raw) ? textValue(raw.filter((v) => typeof v === 'string' && !HEX_ID.test(v))) : null };
    case 'line_items':
      return { t: 'text', v: null };
    default:
      return { t: 'text', v: textValue(raw) };
  }
}

/** The record's name: the first non-empty group of cap.ids.title (a group
 * may join several fields, "firstName lastName"), else its number. */
export function titleOf(cap: ModuleCap, record: Record<string, unknown>): string {
  for (const group of cap.ids.title) {
    const parts = group.split(/[\s+]+/).filter(Boolean).map((path) => textValue(getPath(record, path), 200)).filter(Boolean);
    if (parts.length) return clip(parts.join(' '), 200);
  }
  const number = cap.ids.business ? textValue(record[cap.ids.business], 80) : null;
  return number ?? cap.labels.singular;
}

function businessNumberOf(cap: ModuleCap, record: Record<string, unknown>): string | undefined {
  if (!cap.ids.business) return undefined;
  const value = textValue(record[cap.ids.business], 80);
  return value ?? undefined;
}

function rowFor(
  cap: ModuleCap, record: Record<string, unknown>, columns: Array<{ field: FieldCap; column: Column }>,
  read: ReadContext, env: ComposeEnv, index: number,
): Row {
  const id = idOf(record);
  const cells: Record<string, Cell> = {};
  for (const { field, column } of columns) cells[column.key] = cellFor(cap, field, record, read, env);
  const number = businessNumberOf(cap, record);
  const href = id ? recordLinkFor(cap.key, id) : undefined;
  return {
    key: id ?? `r${index + 1}`,
    ...(id ? { entity: { module: cap.key, id, ...(number ? { number } : {}), label: titleOf(cap, record), source: cap.group } } : {}),
    ...(href ? { href } : {}),
    cells,
  };
}

/* ── Notices ───────────────────────────────────────────────────────────── */

export function notice(id: string, code: string, text: string, tone: NoticeBlock['tone'] = 'info', extra: Partial<NoticeBlock> = {}): NoticeBlock {
  return { id, type: 'notice', tone, code, text: clip(scrubIds(text), 1000), ...extra };
}

/** Decision D1: customer lists and module counts are Field Service only;
 * the per-source count ("how many customers do we have") covers the rest. */
function otherCustomerSourcesNotice(id: string): NoticeBlock {
  return notice(id, 'other_sources_not_included',
    'Native CRM contacts marked as customers and connector accounts are not included here. Ask "how many customers do we have" to count each source separately.');
}

/** Executor Q's notes as notice blocks, ids `${prefix}${n}` from `first`. */
export function queryNoticeBlocks(notices: readonly QueryNotice[] | undefined, source: SourceRef, prefix: string, first: number): NoticeBlock[] {
  return (notices ?? []).map((n, i) => notice(`${prefix}${first + i}`, clip(n.code || 'query_notice', 60), n.text, n.tone === 'warning' ? 'warning' : 'info', { source }));
}

/** The list a count drills into: the same target, conditions, search, "mine" and relation. */
export function drillPlanOf(plan: QueryPlan): QueryPlan {
  return {
    v: 1, op: 'list', target: plan.target,
    ...(plan.where?.length ? { where: plan.where } : {}),
    ...(plan.search ? { search: plan.search } : {}),
    ...(plan.mine ? { mine: plan.mine } : {}),
    ...(plan.relation ? { relation: plan.relation } : {}),
  };
}

/** The chips an empty answer lists after "No … match:". A "mine" plan already
 * says whose records they are ("No Field Service deals assigned to you match:
 * Overdue."), so its "mine" chip isn't repeated. */
export function matchedBy(filters: readonly { id: string; label: string }[]): string[] {
  return filters.filter((f) => f.id !== 'mine').map((f) => f.label);
}

export function chipContextFor(read: ReadContext | null | undefined, run: QueryRun): ChipContext {
  return { status: read?.status ?? null, branchCurrency: read?.currency ?? null, implied: run.implied ?? [] };
}

export type PartialState = SectionState & { status: 'partial'; partialReasons: PartialReason[] };

/** The state of an answer the relation made partial (the related module's
 * scope is narrower than everything, or too many keys), with its words. */
export function relationPartialState(relation: RelationWords | undefined): PartialState | null {
  if (!relation?.partialReasons?.length) return null;
  return { status: 'partial', partialReasons: [...relation.partialReasons], ...(relation.partial ? { message: clip(relation.partial, 500) } : {}) };
}

/** What an answer always says about what it asked: contracts marked "No end
 * date" never expire, so an "expiring" answer leaves them out
 * (registry/query-caps.ts contract.expiring). */
export function planNotices(cap: ModuleCap, plan: QueryPlan): QueryNotice[] {
  const also = queryCapsFor(cap.key)?.expiring?.also;
  const expiring = (plan.where ?? []).some((cond) => cond.op === 'state' && cond.v === 'expiring');
  if (!expiring || !also || !Object.prototype.hasOwnProperty.call(also, 'noEndDate')) return [];
  return [{ code: 'no_end_date', tone: 'info', text: `${cap.labels.plural} marked "No end date" are left out: they never expire.` }];
}

/* ── Answers ───────────────────────────────────────────────────────────── */

/** Increment 8: whether a list offers "Open Daily Events": the caller's
 * Daily Events switch is on (env.dailyEventsOn, asked only for such lists),
 * the module is one Daily Events shows (RECORD_SOURCES) and the plan asks for
 * what it shows today: a due-today or overdue state. */
function offersDailyEvents(cap: ModuleCap, plan: QueryPlan, env: ComposeEnv): boolean {
  return env.dailyEventsOn === true && plan.op === 'list'
    && RECORD_SOURCES.some((d) => d.module === cap.key)
    && (plan.where ?? []).some((cond) => cond.op === 'state' && (cond.v === 'due_today' || cond.v === 'overdue'));
}

/** The table a list plan gives, on either executor: chips for its
 * conditions (removable: the handle can re-run without them), the columns
 * it can be sorted by (sortableOn), the sort that ran, the page and the handle
 * {plan, section, executor}, and (Increment 8) openDailyEvents when the list
 * is one Daily Events shows (offersDailyEvents). Used by the chat answer and
 * by the view route (POST /api/v1/ai/crm-assist/view), which returns this
 * block alone. */
export function composeTable(
  cap: ModuleCap, plan: QueryPlan, result: ListOutcome, env: ComposeEnv, run: QueryRun = L_RUN,
  noticeIds: { prefix: string; first: number } = { prefix: 'n', first: 1 },
): { table: DataTableBlock; notices: NoticeBlock[]; interpretedAs: string } {
  const source = sourceRefFor(cap, env.scopeKind);
  const columns = tableColumns(cap, result.read, sortableOn(cap, plan, run.executor, run.fsRankable !== false));
  const rows = result.items.slice(0, VIEW_CAPS.rows).map((item, i) => rowFor(cap, item, columns, result.read, env, i));
  const chipCtx = chipContextFor(result.read, run);
  const filters = filterChips(cap, plan, chipCtx, true, run.relation);
  const sort = run.sort ?? plan.sort;
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, {
    conditions: conditionPhrases(cap, plan, chipCtx, run.relation), ...(sort ? { sort } : {}),
  }), 300);
  const visible = recordsPhrase(cap, plan, env.scopeKind);
  const partial = relationPartialState(run.relation);
  let state: SectionState = partial ?? { status: 'ok' };
  if (rows.length === 0) {
    // The filters are repeated, so an empty answer says what was asked.
    const matched = matchedBy(filters);
    const message = result.total > 0 ? `No more ${visible} to show.`
      : matched.length ? `No ${visible} match: ${matched.join(', ')}.`
        : `No ${visible} yet.`;
    state = { status: 'empty', message: clip(scrubIds(message), 500), ...(partial ? { partialReasons: partial.partialReasons } : {}) };
  }
  const listLink = listLinkFor(cap.key);
  const size = Math.min(Math.max(result.size, 1), VIEW_CAPS.rows);
  const table: DataTableBlock = {
    id: TABLE_BLOCK_ID,
    type: 'data_table',
    title: cap.labels.plural,
    source,
    state,
    columns: columns.map((c) => c.column),
    rows,
    page: { index: result.page, size, total: result.total, hasMore: result.page * size < result.total },
    ...(sort ? { sort: { key: clip(sort.by, 80), dir: sort.dir } } : {}),
    filters,
    interpretedAs,
    handle: { plan, section: cap.group, executor: run.executor },
    ...(listLink ? { listLink } : {}),
    ...(offersDailyEvents(cap, plan, env) ? { openDailyEvents: true } : {}),
  };
  const notes = [...(run.notices ?? []), ...planNotices(cap, plan)];
  return { table, notices: queryNoticeBlocks(notes, source, noticeIds.prefix, noticeIds.first), interpretedAs };
}

/** A list answer: the table in a one-section source_group. Executor Q's notes
 * sit in that section right after the table, with ids `${table.id}-n1`,
 * `${table.id}-n2`, …, so the browser can swap them for a re-run's own notes.
 * The section's state is 'ok': the table draws its own (empty) state, which a
 * re-run replaces too, so nothing around it can go stale. */
export function composeList(
  cap: ModuleCap, plan: QueryPlan, result: ListOutcome, env: ComposeEnv, run: QueryRun = L_RUN,
): ComposedAnswer {
  const { table, notices, interpretedAs } = composeTable(cap, plan, result, env, run, { prefix: `${TABLE_BLOCK_ID}-n`, first: 1 });
  const group: SourceGroupBlock = {
    id: 'b1', type: 'source_group', title: cap.labels.plural,
    sections: [{ source: table.source, state: { status: 'ok' }, blocks: [table, ...notices] }],
  };
  const blocks: ViewBlock[] = [group];
  if (cap.key === 'customer') blocks.push(otherCustomerSourcesNotice(`b${blocks.length + 1}`));
  const summary = summaries.list(cap, table.rows.length, result.total, !!plan.mine, partialMineWords(cap, plan, env.scopeKind));
  return { blocks, summary, interpretedAs, plan, dataRead: true };
}

/** A count tile. Its drill handle lists the same records (same target,
 * conditions, search and "mine") on the same executor, so the list's total is
 * the count; its hint names the conditions ("Assigned to you; Overdue"). `read`
 * (stage labels, currency) is only needed to word the conditions of an
 * executor Q count. */
export function composeCount(
  cap: ModuleCap, plan: QueryPlan, total: number | null, env: ComposeEnv, run: QueryRun = L_RUN, read: ReadContext | null = null,
): ComposedAnswer {
  const source = sourceRefFor(cap, env.scopeKind);
  const chipCtx = chipContextFor(read, run);
  const chips = filterChips(cap, plan, chipCtx, false, run.relation);
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, { conditions: conditionPhrases(cap, plan, chipCtx, run.relation) }), 300);
  const href = listLinkFor(cap.key);
  const kpi: KpiGroupBlock = {
    id: 'b1',
    type: 'kpi_group',
    title: cap.labels.plural,
    items: [{
      key: `${cap.key}-count`,
      label: clip(env.scopeKind === 'all' ? cap.labels.plural : `${cap.labels.plural} you can see`, 120),
      source,
      // A count that couldn't be read is null with an error state, never 0.
      state: total === null ? { status: 'error', message: `Couldn't read ${cap.labels.plural} right now.`, retryable: true }
        : relationPartialState(run.relation) ?? { status: 'ok' },
      value: total === null ? null : { t: 'number', v: total },
      ...(chips.length ? { hint: clip(chips.map((c) => c.label).join('; '), 300) } : {}),
      drill: { plan: drillPlanOf(plan), section: cap.group, executor: run.executor },
      ...(href ? { href } : {}),
    }],
  };
  const blocks: ViewBlock[] = [kpi, ...queryNoticeBlocks([...(run.notices ?? []), ...planNotices(cap, plan)], source, 'b', 2)];
  if (cap.key === 'customer') blocks.push(otherCustomerSourcesNotice(`b${blocks.length + 1}`));
  const summary = summaries.count(cap, total, !!plan.mine, partialMineWords(cap, plan, env.scopeKind));
  return { blocks, summary, interpretedAs, plan, dataRead: true };
}

/* ── Breakdowns ("leads by source", "work orders per month") ──────────── */

export const BUCKET_LABELS: Readonly<Record<string, string>> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

export function groupCell(key: string | null, group: NonNullable<QueryPlan['group']>, field: FieldCap | undefined, read: ReadContext): Cell {
  if (key === null || key === '') return { t: 'text', v: group.bucket ? 'No date' : 'Not set' };
  if (group.bucket) return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { t: 'date', v: key } : { t: 'text', v: textValue(key) };
  if (field && isStatusField(field, read.status)) return statusCell(key, read.status);
  if (field?.kind === 'boolean') return { t: 'bool', v: key === 'true' ? true : key === 'false' ? false : null };
  if (field?.kind === 'enum') return { t: 'text', v: clip(humanize(key), 300) };
  return { t: 'text', v: textValue(key) };
}

/** A count per group as a table [group, count]: status cells for stage
 * groups, dates for buckets. At most 25 rows (the rest is a partial state,
 * row_cap); no handle, so no paging, sorting or chip removal. Past 25, a
 * breakdown by a field keeps its biggest groups, and a breakdown by date
 * shows exactly the buckets executor Q kept, the 25 nearest today
 * (bucketsKept 'nearest', oldest first). An older executor Q's 'latest' or
 * 'earliest' keeps that end of its (oldest first) buckets. */
export function composeGroups(
  cap: ModuleCap, plan: QueryPlan,
  result: {
    groups: readonly GroupRow[]; totalGroups: number; total: number; read: ReadContext;
    implied?: readonly ImpliedCondition[]; notices?: readonly QueryNotice[];
    bucketsKept?: 'nearest' | 'latest' | 'earliest';
  },
  env: ComposeEnv,
  relation?: RelationWords,
): ComposedAnswer {
  const group: NonNullable<QueryPlan['group']> = plan.group ?? { by: cap.stage?.field ?? 'status' };
  const field = cap.fields.find((f) => f.key === group.by || f.path === group.by);
  const source = sourceRefFor(cap, env.scopeKind);
  const run: QueryRun = { executor: 'Q', implied: result.implied, notices: result.notices };
  const chipCtx = chipContextFor(result.read, run);
  const filters = filterChips(cap, plan, chipCtx, false, relation);
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, { conditions: conditionPhrases(cap, plan, chipCtx, relation) }), 300);
  const groupKind: Column['kind'] = group.bucket ? 'date'
    : field && isStatusField(field, result.read.status) ? 'status'
      : field?.kind === 'boolean' ? 'bool' : 'text';
  const columns: Column[] = [
    { key: 'group', label: clip(group.bucket ? BUCKET_LABELS[group.bucket] ?? humanize(group.bucket) : field?.label ?? humanize(group.by), 120), kind: groupKind, align: 'left', sortable: false, priority: 1 },
    { key: 'count', label: clip(cap.labels.plural, 120), kind: 'number', align: 'right', sortable: false, priority: 1 },
  ];
  // Executor Q already kept the 25 buckets nearest today: nothing more is cut.
  const nearest = !!group.bucket && result.bucketsKept === 'nearest';
  // Untrimmed date buckets one row over the table's limit: 25 dated buckets plus
  // the no-date one. The dated ones are shown and the caption says the
  // no-date group isn't, rather than calling them "the latest".
  const noDateLeftOut = !!group.bucket && result.bucketsKept === undefined && result.groups.length > VIEW_CAPS.rows
    && result.groups.filter((g) => g.key !== null && g.key !== '').length <= VIEW_CAPS.rows;
  const latest = !!group.bucket && !nearest && !noDateLeftOut && result.bucketsKept !== 'earliest';
  const kept = nearest ? result.groups
    : noDateLeftOut ? result.groups.filter((g) => g.key !== null && g.key !== '')
      : latest ? result.groups.slice(-VIEW_CAPS.rows) : result.groups.slice(0, VIEW_CAPS.rows);
  const rows: Row[] = kept.map((g, i) => ({
    key: `g${i + 1}`,
    cells: { group: groupCell(g.key, group, field, result.read), count: { t: 'number', v: g.count } },
  }));
  const totalGroups = Math.max(result.totalGroups, rows.length);
  const capped = totalGroups > rows.length;
  const which = !group.bucket ? '' : latest ? 'the latest ' : 'the earliest ';
  const shown = nearest ? `the ${rows.length} groups nearest today of ${totalGroups}`
    : noDateLeftOut ? `${rows.length} of ${totalGroups} groups; the group of records with no date isn't shown`
      : `${which}${rows.length} of ${totalGroups} groups`;
  const visible = recordsPhrase(cap, plan, env.scopeKind);
  const matched = matchedBy(filters);
  const partial = relationPartialState(relation);
  const reasons = partial?.partialReasons ?? [];
  const state: SectionState = rows.length === 0
    ? {
      status: 'empty', message: clip(scrubIds(matched.length ? `No ${visible} match: ${matched.join(', ')}.` : `No ${visible} to count yet.`), 500),
      ...(reasons.length ? { partialReasons: reasons } : {}),
    }
    : capped ? {
      status: 'partial', partialReasons: ['row_cap', ...reasons],
      message: clip(`Showing ${shown}.${partial?.message ? ` ${partial.message}` : ''}`, 500),
    }
      : partial ?? { status: 'ok' };
  const per = group.bucket ? `per ${(BUCKET_LABELS[group.bucket] ?? group.bucket).toLowerCase()}` : `by ${lowerLabel(field?.label ?? group.by)}`;
  const listLink = listLinkFor(cap.key);
  const table: DataTableBlock = {
    id: 'b1',
    type: 'data_table',
    title: clip(`${cap.labels.plural} ${per}`, 200),
    source,
    state,
    columns,
    rows,
    page: { index: 1, size: VIEW_CAPS.rows, total: totalGroups, hasMore: capped },
    filters,
    interpretedAs,
    ...(listLink ? { listLink } : {}),
  };
  return {
    blocks: [table, ...queryNoticeBlocks([...(result.notices ?? []), ...planNotices(cap, plan)], source, 'b', 2)],
    summary: summaries.groups(cap, totalGroups, result.total, !!plan.mine, partialMineWords(cap, plan, env.scopeKind)),
    interpretedAs,
    plan,
    dataRead: true,
  };
}

/* ── Named totals (Increment 5: registry/metrics.ts) ──────────────────── */

const moneyCell = (v: number | null, currency: string | null): Extract<Cell, { t: 'money' }> => ({ t: 'money', v, currency: currency ? clip(currency, 8) : null });

/** Which bucket a bucket's first day is, counted as query/execute-query.ts
 * bucketDistance counts them (consecutive buckets differ by 1): days and
 * weeks (from Monday) since 1970, months, quarters and years since year 0. */
function bucketOrdinal(dayKey: string, bucket: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  const days = Date.UTC(year, month - 1, day) / 86_400_000;
  switch (bucket) {
    case 'day': return days;
    case 'week': return Math.floor((days + 3) / 7);
    case 'quarter': return year * 4 + Math.floor((month - 1) / 3);
    case 'year': return year;
    default: return year * 12 + month - 1;
  }
}

/** The `max` dated rows nearest today's bucket (a tie goes to the earlier
 * one; a key that isn't a day gives way first), in the order they came (oldest first). */
function nearestToday(rows: readonly MetricRow[], bucket: string, max: number, todayKey: string): MetricRow[] {
  const today = bucketOrdinal(todayKey, bucket);
  const placed = rows.map((row, i) => {
    const at = row.key && /^\d{4}-\d{2}-\d{2}$/.test(row.key) ? bucketOrdinal(row.key, bucket) : null;
    return { i, at: at ?? 0, d: at === null ? Infinity : Math.abs(at - today) };
  });
  const kept = placed.sort((a, b) => (a.d === b.d ? 0 : a.d - b.d) || a.at - b.at || a.i - b.i).slice(0, max);
  return kept.map((p) => p.i).sort((a, b) => a - b).map((i) => rows[i]);
}

/** One table of a named total's rows [group, total, records, currency]:
 * composeMetric's breakdown, and the table under a named-total chart
 * (views/chart.ts). `part.rows` are one currency's (or all of them, in one
 * currency), `part.groups` how many rows there are, at most `part.maxRows`
 * (default VIEW_CAPS.rows) shown. The group cell is `part.groupCell`'s (the
 * column takes its kind), else: a reference (a customer) by its name in
 * `labels`, else its stored number, never a record id (the module's name
 * then); a stage as its status cell; a date bucket as its first day;
 * anything else as text; a row without a value "No <field>". By date, when
 * the rows don't fit, the no-date row gives way first, then the buckets
 * furthest from the read's today (outcome.clock), the rest oldest first.
 * Rows left out make a partial state: "Top 10 of N.", or by date "Showing
 * the 25 months nearest today of N." (N the dated buckets), the no-date row
 * left out said as composeGroups says it. No handle: no paging, sorting or
 * chip removal. */
export function metricTable(
  cap: ModuleCap, plan: QueryPlan, outcome: MetricOutcome, env: ComposeEnv, labels: ReadonlyMap<string, string>,
  part: { id: string; title: string; rows: MetricOutcome['rows']; groups: number; maxRows?: number; groupCell?: (row: MetricRow) => Cell },
  shared: { chips: FilterChip[]; interpretedAs: string; relation?: RelationWords },
): DataTableBlock {
  const metric = outcome.metric;
  const source = sourceRefFor(cap, env.scopeKind);
  const groupBy = plan.group?.by ?? '';
  const bucket = plan.group?.bucket;
  const field = cap.fields.find((f) => f.key === groupBy || f.path === groupBy);
  const refModule = bucket ? undefined : field?.ref?.module;
  const refLink = refModule && env.canViewModule(refModule) ? listLinkFor(refModule) : undefined;
  const stage = !bucket && !!field && isStatusField(field, outcome.read.status);
  const groupLabelText = field?.label ?? groupBy;
  const visible = recordsPhrase(cap, plan, env.scopeKind);
  const matched = matchedBy(shared.chips);
  const partial = relationPartialState(shared.relation);
  const listLink = listLinkFor(cap.key);
  const maxRows = part.maxRows ?? VIEW_CAPS.rows;
  const defaultCell = (row: MetricRow): Cell => {
    if (row.key === null) return { t: 'text', v: `No ${lowerLabel(groupLabelText)}` };
    if (bucket) return /^\d{4}-\d{2}-\d{2}$/.test(row.key) ? { t: 'date', v: row.key } : { t: 'text', v: textValue(row.key) };
    if (stage) return statusCell(row.key, outcome.read.status);
    if (!refModule) return { t: 'text', v: textValue(row.key) };
    const name = labels.get(row.key);
    // A key that is a record id (a customer stored by its _id) reads as the module's name, as a chart's ranking does.
    const number = clip(scrubIds(row.key), 80);
    return {
      t: 'ref', label: clip(scrubIds(name ?? row.key) || scrubIds(row.key), 200) || getModuleCap(refModule)?.labels.singular || groupLabelText || 'Record',
      ...(name && name !== row.key && number ? { number } : {}),
      ...(refLink ? { href: refLink } : {}),
    };
  };
  const cellOf = part.groupCell ?? defaultCell;
  // By date, past maxRows: the no-date row gives way first, then the buckets furthest from today's.
  const over = !!bucket && part.rows.length > maxRows;
  const noDate = !!bucket && part.rows.some((row) => row.key === null);
  const dated = over ? part.rows.filter((row) => row.key !== null) : part.rows;
  const fitted = over && dated.length > maxRows
    ? nearestToday(dated, bucket!, maxRows, outcome.clock?.todayKey ?? buildDayWindows(env.timezone).todayKey) : dated;
  const shown = fitted.slice(0, maxRows);
  const rows: Row[] = shown.map((row, i) => ({
    key: `g${i + 1}`,
    cells: {
      group: cellOf(row), total: moneyCell(row.value, row.currency), count: { t: 'number', v: row.count },
      currency: { t: 'text', v: row.currency ? clip(row.currency, 8) : null },
    },
  }));
  const valued = rows.find((_, i) => shown[i].key !== null)?.cells.group;
  const groupKind: Column['kind'] = part.groupCell ? (valued?.t ?? 'text')
    : bucket ? 'date' : stage ? 'status' : refModule ? 'ref' : 'text';
  const totalGroups = Math.max(part.groups, rows.length);
  const capped = totalGroups > rows.length;
  // By date the no-date group is never counted as a bucket; left out, it is said as composeGroups' noDateLeftOut says it.
  const noDateLeftOut = over && noDate;
  const buckets = shown.filter((row) => row.key !== null).length;
  const datedGroups = Math.max(part.groups - (noDate ? 1 : 0), buckets);
  const cut = !bucket ? `Top ${rows.length} of ${totalGroups}.`
    : noDateLeftOut && datedGroups <= buckets ? `Showing ${rows.length} of ${totalGroups} groups; the group of records with no date isn't shown.`
      : `Showing the ${buckets} ${bucket}s nearest today of ${datedGroups}${noDateLeftOut ? '; the group of records with no date isn\'t shown' : ''}.`;
  const state: SectionState = rows.length === 0
    ? {
      status: 'empty', message: clip(scrubIds(matched.length ? `No ${visible} match: ${matched.join(', ')}.` : `No ${visible} to total yet.`), 500),
      ...(partial ? { partialReasons: partial.partialReasons } : {}),
    }
    : capped ? {
      status: 'partial', partialReasons: ['row_cap', ...(partial?.partialReasons ?? [])],
      message: clip(`${cut}${partial?.message ? ` ${partial.message}` : ''}`, 500),
    }
      : partial ?? { status: 'ok' };
  return {
    id: part.id,
    type: 'data_table',
    title: clip(part.title, 200),
    source,
    state,
    columns: [
      {
        key: 'group', label: clip(bucket ? BUCKET_LABELS[bucket] ?? humanize(bucket) : groupLabelText, 120), kind: groupKind,
        align: 'left', sortable: false, priority: 1,
      },
      { key: 'total', label: clip(metric.label, 120), kind: 'money', align: 'right', sortable: false, priority: 1 },
      { key: 'count', label: clip(cap.labels.plural, 120), kind: 'number', align: 'right', sortable: false, priority: 2 },
      { key: 'currency', label: 'Currency', kind: 'text', align: 'left', sortable: false, priority: 3 },
    ],
    rows,
    page: { index: 1, size: Math.min(Math.max(outcome.top, 1), VIEW_CAPS.rows), total: totalGroups, hasMore: capped },
    filters: shared.chips,
    interpretedAs: shared.interpretedAs,
    ...(listLink ? { listLink } : {}),
  };
}

/** A named total (query/metrics.ts executeQueryMetric), never added or ranked
 * across currencies. Without a breakdown: one tile per currency ("Payments
 * received in INR"); a tile has the list behind it as its drill handle only
 * when every row is in one currency (that list can't be cut by currency), and
 * always the module's page. With one: a table, one row per value (label,
 * total, records, currency), largest first, "Top 10 of N" when more rows
 * exist; rows in several currencies make one such table per currency
 * ("Purchase amount by customer in INR"), each ranked and cut on its own, the
 * caller's currency first, as many as the reply's blocks allow (a notice names
 * the currencies left out). The rows' names come from `labels` (the group
 * field's module, read under that module's own gates: query/relations.ts
 * relatedLabels); a value the caller can't see by name shows its stored
 * number. The metric's definition (basis) is always shown under it. Nothing
 * matched is a total of 0: the read ran. Increment 8: each table is
 * metricTable's; a breakdown by stage shows stage cells, and one by date
 * ("Payments received per month") a row per bucket, oldest first. */
export function composeMetric(
  cap: ModuleCap, plan: QueryPlan, outcome: MetricOutcome, env: ComposeEnv, labels: ReadonlyMap<string, string> = new Map(),
  relation?: RelationWords,
): ComposedAnswer {
  const metric = outcome.metric;
  const source = sourceRefFor(cap, env.scopeKind);
  const run: QueryRun = { executor: 'Q', implied: outcome.implied, notices: outcome.notices };
  const chipCtx = chipContextFor(outcome.read, run);
  const chips = filterChips(cap, plan, chipCtx, false, relation);
  const groupBy = plan.group?.by;
  const bucket = plan.group?.bucket;
  const groupField = groupBy ? cap.fields.find((f) => f.key === groupBy || f.path === groupBy) : undefined;
  const conditions = conditionPhrases(cap, plan, chipCtx, relation);
  const interpretedAs = clip(interpretMetric(plan, cap, env.scopeKind, metric.label, {
    conditions, ...(groupBy ? { per: bucket ?? groupField?.label ?? groupBy } : {}), ...(metric.currency ? { ownCurrency: true } : {}),
  }), 300);
  const partial = relationPartialState(relation);
  const notes = [...outcome.notices, ...planNotices(cap, plan)];
  const currencies = new Set(outcome.rows.map((row) => row.currency ?? '')).size;
  const href = listLinkFor(cap.key);
  const noun = (n: number) => lowerLabel(n === 1 ? cap.labels.singular : cap.labels.plural);
  const named = (currency: string | null) => currency ?? 'an unrecorded currency';
  let main: ViewBlock[];
  const after: NoticeBlock[] = [];

  if (!groupBy) {
    // Nothing matched: a total of 0 in the caller's currency (the read ran and found none).
    const rows = outcome.rows.length ? outcome.rows : [{ key: null, currency: outcome.read.currency, value: 0, count: 0 }];
    const several = rows.length > 1;
    // One list behind several currencies' tiles would show records outside each tile's number.
    const drill: QueryHandle | undefined = outcome.drill && !several ? { plan: outcome.drill, section: cap.group, executor: 'Q' } : undefined;
    main = [{
      id: 'b1',
      type: 'kpi_group',
      title: clip(metric.label, 200),
      items: rows.slice(0, VIEW_CAPS.kpis).map((row, i): KpiItem => ({
        key: clip(`${cap.key}-${metric.key}-${i + 1}`, 80),
        label: clip(several ? `${metric.label} in ${named(row.currency)}` : metric.label, 120),
        source,
        // A total that couldn't be read is null with an error state, never 0.
        state: row.value === null ? { status: 'error', message: `Couldn't total ${lowerLabel(cap.labels.plural)} right now.`, retryable: true }
          : partial ?? { status: 'ok' },
        value: row.value === null ? null : moneyCell(row.value, row.currency),
        hint: clip(scrubIds([`From ${row.count} ${noun(row.count)}`, ...chips.map((c) => c.label)].join('; ')), 300),
        ...(drill ? { drill } : {}),
        ...(href ? { href } : {}),
      })),
    }];
  } else {
    const groupLabelText = groupField?.label ?? groupBy;
    // By date: "Payments received per month", as a breakdown of counts by date reads.
    const title = bucket ? `${metric.label} per ${bucket}` : `${metric.label} by ${lowerLabel(groupLabelText)}`;
    const shared = { chips, interpretedAs, ...(relation ? { relation } : {}) };
    /** One table of `rows` (one currency's, or all of them in one currency), `groups` the rows there are. */
    const tableOf = (id: string, tableTitle: string, metricRows: MetricOutcome['rows'], groups: number): DataTableBlock =>
      metricTable(cap, plan, outcome, env, labels, { id, title: tableTitle, rows: metricRows, groups }, shared);
    const sections = outcome.groupsByCurrency ?? [];
    if (sections.length <= 1) {
      main = [tableOf('b1', title, outcome.rows, outcome.totalGroups)];
    } else {
      // A table per currency, within the reply's blocks: the tables, the basis, the notes and, when some
      // currencies don't fit, the notice naming them.
      const room = VIEW_CAPS.blocks - 1 - notes.length;
      const fit = sections.length <= room ? sections.length : Math.max(1, room - 1);
      main = sections.slice(0, fit).map((s, i) => tableOf(
        i === 0 ? 'b1' : `b1-${i + 1}`, `${title} in ${named(s.currency)}`, outcome.rows.filter((row) => row.currency === s.currency), s.groups,
      ));
      const left = sections.slice(fit).map((s) => named(s.currency));
      if (left.length) {
        after.push(notice(`b${3 + notes.length}`, 'more_currencies',
          `${metric.label} in ${left.length} more ${left.length === 1 ? 'currency' : 'currencies'} (${left.join(', ')}) is not shown here.`,
          'info', { source }));
      }
    }
  }
  return {
    blocks: [...main, notice('b2', 'metric_basis', outcome.basis, 'info', { source }), ...queryNoticeBlocks(notes, source, 'b', 3), ...after],
    summary: summaries.metric(cap, metric.label, outcome.rows.length, currencies, !!groupBy),
    interpretedAs,
    plan,
    dataRead: true,
  };
}

/* ── Per-source counts: concepts and connectors ───────────────────────── */

/** The message a tile shows in a state without a number (server text). */
function stateMessageFor(state: SectionState, source: SourceRef): string | undefined {
  const connector = source.key.startsWith('connector:');
  const what = connector ? `${source.label} ${source.moduleLabel}` : source.moduleLabel;
  switch (state.status) {
    case 'no_permission': return `You don't have access to ${what}.`;
    case 'disabled': return connector ? `${source.label} is turned off for your company.` : `${source.moduleLabel} are turned off for your company.`;
    case 'not_connected': return `${source.label} is not connected.`;
    case 'never_synced': return `Nothing has been synced from ${source.label} yet.`;
    case 'not_synced': return `${source.label} is connected but no ${source.moduleLabel} have been synced.`;
    case 'unsupported': return `${what} can't be counted here yet.`;
    case 'error': return `Couldn't read ${what} right now.`;
    default: return undefined;
  }
}

/** One count tile per source, in that source's own state: a number only
 * when it was read (a 0 is a number), else null with a message — never 0
 * for "unavailable". */
function countTile(
  key: string, label: string, source: SourceRef, state: SectionState, value: number | null,
  extra: { drill?: QueryHandle; href?: KpiItem['href'] } = {},
): KpiItem {
  const read = hasData(state) && typeof value === 'number' && Number.isFinite(value);
  let shown: SectionState;
  if (read) {
    // A tile draws a number only for ok/partial; a count of 0 is an ok number.
    shown = state.status === 'empty' ? { status: 'ok' } : state;
  } else if (hasData(state)) {
    // "Read" but no number came back: unavailable, never 0.
    shown = { status: 'error', message: clip(scrubIds(stateMessageFor({ status: 'error' }, source) ?? ''), 500), retryable: true };
  } else {
    const message = state.message ?? stateMessageFor(state, source);
    shown = {
      ...state,
      ...(message ? { message: clip(scrubIds(message), 500) } : {}),
      ...(state.status === 'error' && state.retryable === undefined ? { retryable: true } : {}),
    };
  }
  return {
    key: clip(key, 80),
    label: clip(scrubIds(label), 120) || clip(source.moduleLabel, 120),
    source,
    state: shown,
    value: read ? { t: 'number', v: value as number } : null,
    ...(extra.drill ? { drill: extra.drill } : {}),
    ...(extra.href ? { href: extra.href } : {}),
  };
}

/** "How many customers do we have": ONE kpi_group, one tile per source
 * (Field Service customers, contacts marked as customers, each connected
 * vendor's accounts), each with its own state and freshness, never a total,
 * plus the notice saying so. `connectorsUnchecked` (countConcept's report:
 * the connector lookup failed) adds a warning that the connected CRMs
 * weren't counted; no tile is made up for them. With plan.mine ("how many
 * customers do I have") each tile counts the caller's own records and says
 * whose ("Field Service customers assigned to you"); connector tiles say
 * theirs can't be told apart. */
export function composeConceptCount(
  concept: ConceptKey, plan: QueryPlan, sections: readonly SourceCountSection[], opts: { connectorsUnchecked?: boolean } = {},
): ComposedAnswer {
  const plural = CONCEPTS[concept]?.plural ?? `${concept}s`;
  const mine = plan.mine !== undefined;
  const interpretedAs = clip(interpretConcept(plural, mine), 300);
  const unchecked = opts.connectorsUnchecked === true;
  const uncheckedNotice = (id: string): NoticeBlock[] => (unchecked
    ? [notice(id, 'connectors_unchecked', `Connected CRMs couldn't be checked right now, so their ${lowerLabel(plural)} aren't included. ${TIMED_OUT_NOTE}`, 'warning')]
    : []);
  if (!sections.length) {
    return {
      blocks: [notice('b1', 'no_sources', `There is no source of ${lowerLabel(plural)} you can read.`, 'warning'), ...uncheckedNotice('b2')],
      summary: summaries.concept(plural, [], unchecked, mine),
      interpretedAs,
      dataRead: false,
    };
  }
  const items = sections.slice(0, VIEW_CAPS.kpis).map((s, i) => countTile(
    `${concept}-${s.source.key}-${i + 1}`, s.label, s.source, s.state, s.value,
    { ...(s.drill ? { drill: s.drill } : {}), ...(s.href ? { href: s.href } : {}) },
  ));
  const title = mine ? `Your ${lowerLabel(plural)} by source` : `${sentenceCase(plural)} by source`;
  const kpi: KpiGroupBlock = { id: 'b1', type: 'kpi_group', title: clip(title, 200), items };
  return {
    blocks: [kpi, notice('b2', 'counted_separately', 'Each source is counted separately; they are never added together.'), ...uncheckedNotice('b3')],
    // A count at a vendor's sync cap keeps its "+", as the tile shows it.
    summary: summaries.concept(plural, items.map((it) => `${it.label} ${it.value ? `${it.value.v}${it.state.lowerBound === true ? '+' : ''}` : 'unavailable'}`), unchecked, mine),
    interpretedAs,
    plan,
    dataRead: items.some((it) => hasData(it.state)),
  };
}

/** "How many Salesforce opportunities": one tile in the connector's own
 * state (not connected, never synced, module not synced, no permission,
 * switched off, failed) with its freshness; the stored module names as a
 * notice when they were listed for this caller. */
export function composeConnectorCount(section: ConnectorCountSection): ComposedAnswer {
  const vendor = SOURCE_LABELS[`connector:${section.type}` as keyof typeof SOURCE_LABELS] ?? section.source.label;
  const base = scrubIds(section.label || section.source.moduleLabel);
  const label = base.toLowerCase().includes(vendor.toLowerCase()) ? base : `${vendor} ${base}`;
  const tile = countTile(`connector-${section.type}-count`, label, section.source, section.state, section.value);
  const blocks: ViewBlock[] = [{ id: 'b1', type: 'kpi_group', title: clip(label, 200), items: [tile] }];
  const stored = (section.storedModules ?? []).map((m) => clip(scrubIds(m), 60)).filter(Boolean);
  if (stored.length) {
    const shown = stored.slice(0, 15);
    const more = stored.length > shown.length ? ` and ${stored.length - shown.length} more` : '';
    blocks.push(notice('b2', 'connector_modules',
      `${vendor} modules synced so far: ${shown.join(', ')}${more}. Ask for one by name, for example "how many ${vendor} ${shown[0]}".`));
  }
  const read = hasData(tile.state) && tile.value !== null;
  return {
    blocks,
    // "Counted at least 5000 …" at the vendor's sync cap, as the tile's "5000+".
    summary: summaries.connector(label, read && tile.value ? tile.value.v : null, tile.state.status, read && tile.state.lowerBound === true),
    interpretedAs: clip(`Number of ${label}`, 300),
    dataRead: read,
  };
}

/** The per-source count couldn't run at all: a notice, never a zero. */
export function composeConceptFailed(concept: ConceptKey): ComposedAnswer {
  const plural = CONCEPTS[concept]?.plural ?? `${concept}s`;
  return {
    blocks: [notice('b1', 'query_failed', `Couldn't count ${lowerLabel(plural)} right now.`, 'warning')],
    summary: `Couldn't count ${lowerLabel(plural)}.`,
    interpretedAs: clip(interpretConcept(plural), 300),
    dataRead: false,
  };
}

export function composeConnectorFailed(type: ConnectorType): ComposedAnswer {
  const vendor = SOURCE_LABELS[`connector:${type}` as keyof typeof SOURCE_LABELS] ?? type;
  return {
    blocks: [notice('b1', 'query_failed', `Couldn't read ${vendor} right now.`, 'warning')],
    summary: `Couldn't read ${vendor}.`,
    dataRead: false,
  };
}

/** The tenant's Custom Module definitions couldn't be read (registry/custom-modules.ts rejects): never "no such module". */
export function composeCustomModulesFailed(): ComposedAnswer {
  const label = SOURCE_LABELS.custom_module;
  return {
    blocks: [notice('b1', 'query_failed', `Couldn't read ${label} right now. ${TIMED_OUT_NOTE}`, 'warning')],
    summary: `Couldn't read ${label}.`,
    dataRead: false,
  };
}

/* ── Answers that didn't finish before the resolve deadline ───────────────
 * The AI service stops waiting for an answer after 4 s and asks the existing
 * assistant instead, so the engine answers by its own deadline: whatever
 * hasn't finished is shown in an error state that can be retried — never a
 * zero, never a guess. */

const TIMED_OUT_NOTE = 'Try again in a moment.';

/** A read (list, count, breakdown or record) that didn't finish in time. The
 * gates may not have finished either, so the notice names no scope. */
export function composeReadTimedOut(cap: ModuleCap, plan: QueryPlan): ComposedAnswer {
  const conditions = [
    ...conditionPhrases(cap, plan, { status: null, branchCurrency: null }), ...(plan.relation ? [askedRelationPhrase(plan.relation)] : []),
  ];
  return {
    blocks: [notice('b1', 'query_timeout', `Reading ${cap.labels.plural} took too long. ${TIMED_OUT_NOTE}`, 'warning')],
    summary: summaries.timedOut(`${plan.mine ? 'your ' : ''}${lowerLabel(cap.labels.plural)}`),
    interpretedAs: clip(interpretPlan(plan, cap, 'all', { conditions }), 300),
    dataRead: false,
  };
}

/** "How many customers do we have" didn't finish in time: the same group,
 * one tile per native source in the state the caller's capability view
 * already knows (switched off, no permission) or else an error that can be
 * retried, never a number; a notice says some sources weren't counted (the
 * connector sources depend on reads that didn't finish). */
export function composeConceptTimedOut(
  concept: ConceptKey, plan: QueryPlan, accessOf: (module: string) => ModuleAccess | 'unknown',
): ComposedAnswer {
  const plural = CONCEPTS[concept]?.plural ?? `${concept}s`;
  const sections: SourceCountSection[] = [];
  for (const source of CONCEPTS[concept]?.sources ?? []) {
    if (source.kind !== 'module') continue;
    const cap = getModuleCap(source.module);
    const access = accessOf(source.module);
    if (!cap || access === 'unknown') continue;
    // The label countConcept gives the source: "Field Service customers assigned to you" for "mine".
    const label = plan.mine ? `${source.label} ${lowerLabel(mineLabel(cap, plan.mine))}` : source.label;
    const state: SectionState = access === 'disabled'
      ? { status: 'disabled', message: `${cap.labels.plural} are turned off for your company.` }
      : access === 'no_permission'
        ? { status: 'no_permission', message: `You don't have access to ${cap.labels.plural}.` }
        : { status: 'error', message: `Counting ${lowerLabel(label)} took too long. ${TIMED_OUT_NOTE}`, retryable: true };
    sections.push({ source: sourceRefFor(cap, 'all'), state, value: null, label });
  }
  const timedOut = (id: string) => notice(id, 'query_timeout', `Some sources took too long to count. ${TIMED_OUT_NOTE}`, 'warning');
  const composed = sections.length
    ? composeConceptCount(concept, plan, sections)
    : { blocks: [] as ViewBlock[], interpretedAs: clip(interpretConcept(plural, plan.mine !== undefined), 300) };
  return {
    blocks: [...composed.blocks, timedOut(`b${composed.blocks.length + 1}`)],
    summary: summaries.timedOut(`${plan.mine ? 'your ' : ''}${lowerLabel(plural)} per source`),
    interpretedAs: composed.interpretedAs,
    dataRead: false,
  };
}

/** The name a connector count asked for, before anything resolved: the
 * vendor's usual name ("Opportunities") or the stored module named. */
function askedConnectorModule(type: ConnectorType, target: { concept: ConnectorConcept } | { storedModule: string }): string {
  if ('concept' in target) return CONNECTOR_CONCEPT_MODULES[type]?.[target.concept]?.label ?? 'Records';
  const asked = clip(scrubIds(normaliseModuleName(String(target.storedModule ?? ''))), 60);
  return asked ? asked.charAt(0).toUpperCase() + asked.slice(1) : 'Records';
}

/** "How many Salesforce opportunities" didn't finish in time: the connector
 * tile in an error state that can be retried, never a number. */
export function composeConnectorTimedOut(
  type: ConnectorType, target: { concept: ConnectorConcept } | { storedModule: string },
): ComposedAnswer {
  const vendor = CONNECTOR_TYPE_LABELS[type] ?? SOURCE_LABELS[`connector:${type}` as keyof typeof SOURCE_LABELS] ?? type;
  const module = askedConnectorModule(type, target);
  const composed = composeConnectorCount({
    type,
    source: { key: `connector:${type}` as const, label: vendor, module, moduleLabel: module, scope: 'all' },
    state: { status: 'error', message: `Reading ${vendor} ${module} took too long. ${TIMED_OUT_NOTE}`, retryable: true },
    value: null,
    label: `${vendor} ${module}`,
  });
  return { ...composed, summary: summaries.timedOut(`${vendor} ${module}`) };
}

function detailFields(cap: ModuleCap, record: Record<string, unknown>, read: ReadContext, env: ComposeEnv, leaveOut: ReadonlySet<string>) {
  return cap.fields
    .filter((f) => (f.read === 'list' || f.read === 'detail') && isShowable(f, read) && !leaveOut.has(f.key))
    .slice(0, MAX_DETAIL_FIELDS)
    .map((f) => ({ key: f.key, label: clip(f.label, 120), value: cellFor(cap, f, record, read, env) }));
}

/** At most this many lines, totals, related rows and actions on a card (contracts/views.ts RecordDetailBlockSchema). */
const MAX_CARD_LINES = 50;
const MAX_CARD_TOTALS = 10;
const MAX_CARD_RELATED = 10;
const MAX_CARD_ACTIONS = 6;

const LINE_COLUMNS: Column[] = [
  { key: 'item', label: 'Item', kind: 'text', align: 'left', sortable: false, priority: 1 },
  { key: 'type', label: 'Type', kind: 'text', align: 'left', sortable: false, priority: 3 },
  { key: 'qty', label: 'Qty', kind: 'number', align: 'right', sortable: false, priority: 2 },
  { key: 'amount', label: 'Amount', kind: 'money', align: 'right', sortable: false, priority: 3 },
  { key: 'total', label: 'Line total', kind: 'money', align: 'right', sortable: false, priority: 2 },
];

/** The card's read-only lines (query/detail.ts lineItemsOf), their amounts in
 * the currency the card's other Field Service amounts are shown in. */
function detailLines(rows: readonly DetailLine[], read: ReadContext): NonNullable<RecordDetailBlock['lines']> {
  const currency = read.currency ? clip(read.currency, 8) : null;
  return {
    columns: LINE_COLUMNS,
    rows: rows.slice(0, MAX_CARD_LINES).map((line, i) => ({
      key: `l${i + 1}`,
      cells: {
        item: { t: 'text', v: textValue(line.name, 200) },
        type: { t: 'text', v: line.kind === 'service' ? 'Service' : 'Part' },
        qty: { t: 'number', v: line.qty },
        amount: { t: 'money', v: line.amount, currency },
        total: { t: 'money', v: line.total, currency },
      },
    })),
  };
}

/** A related row counted by a number other records the caller can see also
 * carry (RelatedCount.shared): its children can't be told apart. The number
 * is named only where tables show it, as the "for" answer's warning does
 * (query/relations.ts); a hidden one (staff, teams) is "one number". */
function sharedNumberNote(row: RelatedCount, words: string): string {
  if (!row.shared) return '';
  const parent = getModuleCap(row.def.parent);
  const business = parent?.ids.business;
  const field = business ? parent?.fields.find((f) => f.key === business || f.path === business) : undefined;
  const number = field && field.read !== 'hidden' ? `the number ${row.shared.number}` : 'one number';
  return `${row.shared.records} ${lowerLabel(parent?.labels.plural ?? 'records')} you can see share ${number}, so their ${words} are counted and listed together.`;
}

/** One related row (query/detail.ts relatedCountsFor): its count in the
 * child module's own state, never a zero for "couldn't count", and the list
 * behind it as a drill handle where the caller can use that module. A count
 * shared with other records of the same number is partial, and says so. */
function relatedRow(row: RelatedCount): RecordDetailBlock['related'][number] {
  const plural = row.child.labels.plural;
  const words = lowerLabel(plural);
  const shared = sharedNumberNote(row, words);
  const state: SectionState = row.status === 'no_permission' ? { status: 'no_permission', message: `You don't have access to ${plural}.` }
    : row.status === 'disabled' ? { status: 'disabled', message: `${plural} are turned off for your company.` }
      : row.status === 'error'
        ? { status: 'error', message: row.timedOut ? `Counting ${words} took too long. ${TIMED_OUT_NOTE}` : `Couldn't count ${words} right now.`, retryable: true }
        : row.status === 'partial'
          ? { status: 'partial', partialReasons: ['scope_limited'], message: clip(`Only ${words} visible to you are counted.${shared ? ` ${shared}` : ''}`, 500) }
          : shared ? { status: 'partial', message: clip(shared, 500) } : { status: 'ok' };
  return {
    label: clip(plural, 120),
    source: sourceRefFor(row.child, row.scopeKind ?? 'all'),
    count: row.count,
    state,
    ...(row.drill ? { drill: { plan: row.drill, section: row.child.group, executor: 'Q' as const } } : {}),
  };
}

/** A record card. `extras` (query/detail.ts detailExtrasFor): its read-only
 * lines, its stored totals (which then aren't repeated among the fields) and
 * its related counts, each with the list behind it; and (Increment 6) the
 * actions after "Open": "Edit" and "Delete" start a guided form or a delete
 * review for this record (assist.internal.routes.ts recordActionsFor). */
export function composeDetail(
  cap: ModuleCap, plan: QueryPlan, record: Record<string, unknown>, read: ReadContext, env: ComposeEnv,
  extras: DetailExtrasData & { actions?: readonly RecordAction[] } = {},
): ComposedAnswer {
  const source = sourceRefFor(cap, env.scopeKind);
  const id = idOf(record);
  const number = businessNumberOf(cap, record);
  const title = titleOf(cap, record);
  const href = id ? recordLinkFor(cap.key, id) : listLinkFor(cap.key);
  const statusField = read.status ? cap.fields.find((f) => isStatusField(f, read.status) && isShowable(f, read)) : undefined;
  const status = statusField ? statusCell(getPath(record, statusField.path), read.status) : undefined;
  const currency = read.currency ? clip(read.currency, 8) : null;
  const totals = (extras.totals ?? []).slice(0, MAX_CARD_TOTALS);
  const lines = extras.lines?.rows.length ? detailLines(extras.lines.rows, read) : undefined;
  const linesCut = !!lines && (extras.lines?.total ?? 0) > lines.rows.length;
  const block: RecordDetailBlock = {
    id: 'b1',
    type: 'record_detail',
    source,
    state: linesCut
      ? { status: 'partial', partialReasons: ['row_cap'], message: `Showing ${lines!.rows.length} of ${extras.lines!.total} lines.` }
      : { status: 'ok' },
    record: {
      entity: { module: cap.key, id: id ?? (number ?? cap.key), ...(number ? { number } : {}), label: title, source: cap.group },
      title,
      ...(status && status.t === 'status' ? { status } : {}),
      ...(href ? { href } : {}),
    },
    sections: [{ title: 'Details', fields: detailFields(cap, record, read, env, new Set(totals.map((t) => t.key))) }],
    ...(lines ? { lines } : {}),
    ...(totals.length ? { totals: totals.map((t) => ({ label: clip(t.label, 120), value: { t: 'money' as const, v: t.value, currency } })) } : {}),
    related: (extras.related ?? []).slice(0, MAX_CARD_RELATED).map(relatedRow),
    actions: [
      ...(href ? [{ kind: 'open' as const, label: clip(`Open ${lowerLabel(cap.labels.singular)}`, 80), href }] : []),
      ...(extras.actions ?? []),
    ].slice(0, MAX_CARD_ACTIONS),
  };
  const shownNumber = number ?? (plan.record && 'number' in plan.record ? plan.record.number : '');
  return {
    blocks: [block],
    summary: summaries.detail(cap, shownNumber),
    interpretedAs: clip(interpretPlan(plan, cap, env.scopeKind), 300),
    plan,
    ...(id ? { focus: { module: cap.key, id } } : {}),
    dataRead: true,
  };
}

/** A record's place among matches that read alike, newest first (as views/clarify.ts words it). */
const NEWEST_ORDINALS = ['Newest', 'Second newest', 'Third newest'];

/** At most this long, as a clarify option's label must be (contracts/views.ts). */
const MAX_OPTION_LABEL = 120;

/** The parts of a duplicate's label, joined with " · " to fit MAX_OPTION_LABEL:
 * the title is shortened (or left out) first, so what tells it apart stays. */
function fittedLabel(head: string, title: string | null, rest: readonly string[]): string {
  const join = (parts: Array<string | null>) => scrubIds(parts.filter((p): p is string => !!p).join(' · '));
  const without = join([head, ...rest]);
  if (!title) return clip(without, MAX_OPTION_LABEL);
  const room = MAX_OPTION_LABEL - without.length - 3;
  return clip(room >= 8 ? join([head, clip(title, room), ...rest]) : without, MAX_OPTION_LABEL);
}

/** Each duplicate's choice label, no two alike (the label is also the staff
 * member's line in the chat): number, title, created day and status; where
 * some still read alike, what tells them apart goes into theirs, one part at a
 * time and only a part that differs among them: the time it was created (in
 * the tenant's timezone), its customer, its total; and, last, its place among
 * the matches, newest first ("Second newest"). */
function duplicateLabels(
  cap: ModuleCap, matches: readonly Record<string, unknown>[], number: string, read: ReadContext, env: ComposeEnv,
): string[] {
  const statusField = read.status ? cap.fields.find((f) => isStatusField(f, read.status)) : undefined;
  const customerField = cap.fields.find((f) => f.kind === 'ref' && f.ref?.module === 'customer' && isShowable(f, read));
  const totalField = cap.fields.find((f) => f.kind === 'money' && f.read === 'list' && isShowable(f, read));
  const facts = matches.map((m) => {
    const created = toDate(getPath(m, cap.dates.created));
    const status = statusField ? statusCell(getPath(m, statusField.path), read.status) : null;
    const customer = customerField ? cellFor(cap, customerField, m, read, env) : null;
    const total = totalField ? cellFor(cap, totalField, m, read, env) : null;
    const shownNumber = businessNumberOf(cap, m) ?? number;
    const title = titleOf(cap, m);
    return {
      head: shownNumber,
      title: title !== shownNumber ? title : null,
      day: created ? dayKeyFor(created, 'instant', env.timezone).key : null,
      time: created ? localTime(created, env.timezone) : null,
      status: status && status.t === 'status' ? status.label : null,
      customer: customer?.t === 'ref' && customerField ? `${customerField.label} ${customer.label}` : null,
      total: total?.t === 'money' && total.v !== null && totalField ? `${totalField.label} ${cellText(total)}` : null,
    };
  });
  type Extra = 'time' | 'customer' | 'total';
  const added = facts.map(() => new Set<Extra>());
  const labelAt = (i: number, ordinal?: string) => {
    const f = facts[i];
    const created = f.day ? `created ${f.day}${added[i].has('time') && f.time ? ` ${f.time}` : ''}` : null;
    const rest = [
      created, f.status, added[i].has('customer') ? f.customer : null, added[i].has('total') ? f.total : null, ordinal ?? null,
    ].filter((p): p is string => !!p);
    return fittedLabel(f.head, f.title, rest) || clip(cap.labels.singular, MAX_OPTION_LABEL);
  };
  /** The indexes of each label shared by several. */
  const alike = (labels: readonly string[]) => {
    const groups = new Map<string, number[]>();
    labels.forEach((label, i) => groups.set(label, [...(groups.get(label) ?? []), i]));
    return [...groups.values()].filter((members) => members.length > 1);
  };
  let labels = facts.map((_, i) => labelAt(i));
  for (const extra of ['time', 'customer', 'total'] as const) {
    for (const members of alike(labels)) {
      // A part they all share tells nothing apart: it stays out.
      if (new Set(members.map((i) => facts[i][extra])).size < 2) continue;
      for (const i of members) added[i].add(extra);
    }
    labels = facts.map((_, i) => labelAt(i));
  }
  for (const members of alike(labels)) {
    for (const i of members) labels[i] = labelAt(i, NEWEST_ORDINALS[i] ?? `Number ${i + 1} by newest`);
  }
  return labels;
}

/** Records the caller can see that share one number (work orders, invoices,
 * quotations and contracts have no unique index on it): a question back with
 * a choice per record (number, title, created date, status, and what else
 * tells two apart: duplicateLabels; the newest ten), each opening that record
 * by its _id (record { ref }). More than ten: a note that the rest are on the
 * module's page. */
export function composeDuplicates(
  cap: ModuleCap, plan: QueryPlan, number: string, matches: Record<string, unknown>[], read: ReadContext, env: ComposeEnv,
): ComposedAnswer {
  const shown = matches.slice(0, 10).filter((m) => idOf(m));
  const labels = duplicateLabels(cap, shown, number, read, env);
  const options: ClarifyOption[] = shown.map((m, i) => ({
    label: labels[i], run: { plan: { v: 1, op: 'detail', target: { module: cap.key }, record: { ref: idOf(m)! } } },
  }));
  const more = matches.length > 10;
  const count = more ? 'More than 10' : String(matches.length);
  const question: ClarifyBlock = {
    id: 'b1', type: 'clarify', reason: 'duplicate_number', options,
    question: clip(scrubIds(`${count} ${lowerLabel(cap.labels.plural)} you can see share the number ${number}. Which one do you mean?`), 300),
  };
  const href = listLinkFor(cap.key);
  const blocks: ViewBlock[] = [question];
  if (more) {
    blocks.push(notice('b2', 'more_duplicates', `These are the newest 10; open the others from the ${cap.labels.plural} page.`, 'info', {
      source: sourceRefFor(cap, env.scopeKind), ...(href ? { href } : {}),
    }));
  }
  return {
    blocks,
    summary: summaries.duplicates(cap, number, matches.length),
    interpretedAs: clip(interpretPlan(plan, cap, env.scopeKind), 300),
    plan,
    dataRead: true,
  };
}

/** No record the caller can see: by its number, or (`number` null) by the _id a choice carried. */
export function composeNotFound(cap: ModuleCap, plan: QueryPlan, number: string | null, env: ComposeEnv): ComposedAnswer {
  const singular = lowerLabel(cap.labels.singular);
  const text = number
    ? `I couldn't find a ${singular} numbered ${number} that you can see.`
    : `I couldn't find that ${singular}, or you can't see it.`;
  return {
    blocks: [notice('b1', 'not_found', text, 'info', { source: sourceRefFor(cap, env.scopeKind) })],
    summary: summaries.notFound(cap, number),
    interpretedAs: clip(interpretPlan(plan, cap, env.scopeKind), 300),
    plan,
    dataRead: true,
  };
}

/* ── Relations that can't run as asked (Increment 5) ──────────────────── */

/** The answer when a plan's relation can't run as asked (query/relations.ts
 * prepareRelation): several records match the name (a choice each, re-running
 * the plan for it), no record on screen (the newest the caller can see), the
 * name matches nothing the caller can see (a notice naming where else it is),
 * the other module can't be used (its state), or too many keys. Never an empty
 * list or a zero. null when the tenant was switched off meanwhile: the caller
 * answers that as its own gates do. */
export function composeRelationOutcome(
  cap: ModuleCap, plan: QueryPlan, rel: Exclude<RelationOutcome, { kind: 'ready' }>, env: ComposeEnv,
): ComposedAnswer | null {
  const asked = plan.relation ? askedRelationPhrase(plan.relation) : '';
  const conditions = [...conditionPhrases(cap, plan, { status: null, branchCurrency: null }), ...(asked ? [asked] : [])];
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, { conditions }), 300);
  switch (rel.kind) {
    case 'entity_ambiguous': return { ...composeEntityChoices(rel), interpretedAs };
    case 'no_focus': return { ...composeParentChoices(rel), interpretedAs };
    case 'related_unavailable':
      if (rel.reason === 'tenant_inactive') return null;
      // Nothing was read: the other module's state, as the gates word it.
      return {
        blocks: [notice('b1', clip(rel.notice.code, 60), rel.notice.text, 'warning')],
        summary: summaries.relationRefused(cap),
        interpretedAs,
        dataRead: false,
      };
    case 'entity_not_found': {
      // The parent module was searched (under its own scope): the plan stays the session's last.
      const parent = lowerLabel(rel.parent.labels.singular);
      return {
        blocks: [notice('b1', clip(rel.notice.code, 60), rel.notice.text, 'info')],
        summary: rel.text ? `No ${parent} by that name was found.` : `The ${parent} asked for was not found.`,
        interpretedAs,
        plan,
        dataRead: true,
      };
    }
    default:
      return {
        blocks: [notice('b1', clip(rel.notice.code, 60), rel.notice.text, 'warning', { source: sourceRefFor(cap, env.scopeKind) })],
        summary: summaries.relationRefused(cap),
        interpretedAs,
        dataRead: false,
      };
  }
}

/** The module is switched off, or the caller has no view permission: an
 * answer in that state, never a zero and never a hand-off. */
export function composeModuleState(cap: ModuleCap, state: 'disabled' | 'no_permission'): ComposedAnswer {
  const text = state === 'disabled'
    ? `${cap.labels.plural} are turned off for your company.`
    : `You don't have access to ${cap.labels.plural}.`;
  return {
    blocks: [notice('b1', state === 'disabled' ? 'module_disabled' : 'no_permission', text, 'warning')],
    summary: state === 'disabled' ? summaries.disabled(cap) : summaries.noPermission(cap),
    dataRead: false,
  };
}

/** "Mine" can't be answered here (no staff profile where the module's rule
 * needs one, or the module records no owner): a notice that says why, never
 * every record and never a zero. */
export function composeMineUnavailable(cap: ModuleCap, plan: QueryPlan, err: MineUnavailableError, env: ComposeEnv): ComposedAnswer {
  return {
    blocks: [notice('b1', err.code, err.text, 'info', { source: sourceRefFor(cap, env.scopeKind) })],
    summary: `Couldn't tell which ${lowerLabel(cap.labels.plural)} are yours.`,
    interpretedAs: clip(interpretPlan(plan, cap, env.scopeKind), 300),
    dataRead: false,
  };
}

/** A table whose "mine" can't be answered when it re-runs (POST /view: the
 * caller's staff profile is gone, or a handle for a module that records no
 * owner): the same table in the 'unsupported' state with err.text and no
 * rows, never a zero. It keeps its handle and chips, so the "mine" chip can
 * still be removed to see the records without it. */
export function composeMineUnavailableTable(
  cap: ModuleCap, plan: QueryPlan, err: MineUnavailableError, env: ComposeEnv, executor: 'L' | 'Q' = 'Q', relation?: RelationWords,
): { table: DataTableBlock; notices: NoticeBlock[]; interpretedAs: string } {
  const chipCtx = chipContextFor(null, { executor });
  const sort = plan.sort;
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, {
    conditions: conditionPhrases(cap, plan, chipCtx, relation), ...(sort ? { sort } : {}),
  }), 300);
  const listLink = listLinkFor(cap.key);
  const table: DataTableBlock = {
    id: TABLE_BLOCK_ID,
    type: 'data_table',
    title: cap.labels.plural,
    source: sourceRefFor(cap, env.scopeKind),
    state: { status: 'unsupported', message: clip(scrubIds(err.text), 500) },
    columns: [],
    rows: [],
    page: { index: plan.page ?? 1, size: Math.min(Math.max(plan.pageSize ?? DEFAULT_LIST_LIMIT, 1), VIEW_CAPS.rows), total: null, hasMore: false },
    ...(sort ? { sort: { key: clip(sort.by, 80), dir: sort.dir } } : {}),
    filters: filterChips(cap, plan, chipCtx, true, relation),
    interpretedAs,
    handle: { plan, section: cap.group, executor },
    ...(listLink ? { listLink } : {}),
  };
  return { table, notices: [], interpretedAs };
}

/** The read failed just now: an error notice, never a zero. */
export function composeQueryFailed(cap: ModuleCap, plan: QueryPlan, env: ComposeEnv): ComposedAnswer {
  return {
    blocks: [notice('b1', 'query_failed', `Couldn't read ${cap.labels.plural} right now.`, 'warning', { source: sourceRefFor(cap, env.scopeKind) })],
    summary: summaries.failed(cap),
    interpretedAs: clip(interpretPlan(plan, cap, env.scopeKind), 300),
    dataRead: false,
  };
}

export function composeGreeting(variant: 'hello' | 'thanks' | 'bye'): ComposedAnswer {
  const text = variant === 'thanks'
    ? "You're welcome. Ask me to list or count your records whenever you need."
    : variant === 'bye'
      ? 'Goodbye! Ask me about your records whenever you need.'
      : 'Hi! Ask me to list or count your records, for example "show me customers" or "how many work orders".';
  return { blocks: [notice('b1', 'greeting', text)], summary: summaries.greeting(), dataRead: false };
}

/** Help, built from what this caller can actually read. */
export function composeHelp(modules: readonly ModuleCap[]): ComposedAnswer {
  if (!modules.length) {
    return {
      blocks: [notice('b1', 'help', "I can list and count your records, but you don't have access to any module I can read yet.")],
      summary: summaries.help(),
      dataRead: false,
    };
  }
  const preferred = ['customer', 'lead', 'workorder', 'invoice', 'deal', 'task'];
  const picks = [...modules].sort((a, b) => (preferred.indexOf(a.key) + 1 || 99) - (preferred.indexOf(b.key) + 1 || 99)).slice(0, 3);
  const examples = [`"show me ${lowerLabel(picks[0].labels.plural)}"`];
  if (picks[1]) examples.push(`"list all ${lowerLabel(picks[1].labels.plural)}"`);
  examples.push(`"how many ${lowerLabel((picks[2] ?? picks[0]).labels.plural)}"`);
  const numbered = picks.find((c) => c.ids.business);
  const tail = numbered ? `, or a ${lowerLabel(numbered.labels.singular)} number to open that record` : '';
  const text = `I can list and count your records, filter them by status, date or amount, and open one by its number. Try: ${examples.join(', ')}${tail}. Anything else goes to the full assistant.`;
  return { blocks: [notice('b1', 'help', text)], summary: summaries.help(), dataRead: false };
}

/* ── Final checks and the answer envelope ──────────────────────────────── */

function nextState(composed: ComposedAnswer, previous?: AssistSessionState): AssistSessionState {
  const state: AssistSessionState = { v: 1 };
  const plan = composed.dataRead && composed.plan ? composed.plan : previous?.lastPlan;
  if (plan && JSON.stringify(plan).length <= MAX_LAST_PLAN_CHARS) state.lastPlan = plan;
  if (composed.focus) state.focus = { ...composed.focus, at: new Date().toISOString() };
  else if (previous?.focus) state.focus = previous.focus;
  // The session's open operation (Increment 6): a form or review sets it, a result clears it (null), anything else keeps it.
  const operationId = composed.operationId === undefined ? previous?.operationId : composed.operationId;
  if (operationId) state.operationId = operationId;
  const checked = AssistSessionStateSchema.safeParse(state);
  return checked.success ? checked.data : { v: 1 };
}

/** What Confirm sends back (Increment 6), only for a review card the answer
 * still shows: a review that failed its checks was replaced, and Confirm is
 * never offered for a review nobody saw. */
function confirmationFor(composed: ComposedAnswer, blocks: readonly ViewBlock[]): AnswerResult['confirmation'] {
  const confirmation = composed.confirmation;
  if (!confirmation) return undefined;
  const checked = OperationConfirmationSchema.safeParse(confirmation);
  const shown = blocks.some((b) => b.type === 'review' && b.operation.id === confirmation.operationId);
  if (checked.success && shown) return checked.data;
  logger.warn('CRM assist: a confirmation without its review card was left out', { valid: checked.success, shown });
  return undefined;
}

/** Validates every block (dropping and replacing any that fail), then the
 * whole envelope, and builds the answer: fallback text, badge, meta,
 * summary, state and (a review card's) confirmation. `path`: how the answer
 * was reached (the grammar, the planner, a clarify choice's plan, a clarify,
 * or a guided form). */
export function finalizeAnswer(composed: ComposedAnswer, previous?: AssistSessionState, path: AnswerPath = 'grammar'): AnswerResult {
  const turnId = `t-${randomUUID()}`;
  const blocks: ViewBlock[] = [];
  composed.blocks.forEach((block, index) => {
    const { views, dropped } = validateViews({ v: VIEWS_VERSION, turnId, blocks: [block] });
    if (views && views.blocks.length === 1 && dropped.length === 0) { blocks.push(views.blocks[0]); return; }
    logger.warn('CRM assist: a composed view block failed validation and was replaced', { index, type: block.type, dropped });
    blocks.push(notice(`dropped-${index + 1}`, 'block_dropped', "Part of this answer couldn't be shown.", 'warning'));
  });
  let checked = validateViews({ v: VIEWS_VERSION, turnId, blocks });
  if (!checked.views || checked.dropped.length) {
    logger.warn('CRM assist: composed views failed validation', { dropped: checked.dropped });
    checked = validateViews({ v: VIEWS_VERSION, turnId, blocks: [notice('b1', 'answer_too_large', "This answer couldn't be shown here. Open the module's page instead.", 'warning')] });
  }
  const views = checked.views!;
  const interpretedAs = composed.interpretedAs ? clip(scrubIds(composed.interpretedAs), 300) : undefined;
  const confirmation = confirmationFor(composed, views.blocks);
  return {
    kind: 'answer',
    response: fallbackText(views.blocks),
    source: composed.dataRead ? sourceBadge(views.blocks) : DEFAULT_SOURCE,
    views,
    meta: { path, llmCalls: 0, ...(interpretedAs ? { interpretedAs } : {}) },
    summary: clip(scrubIds(composed.summary), 300),
    state: nextState(composed, previous),
    ...(confirmation ? { confirmation } : {}),
  };
}
