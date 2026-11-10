import { customFieldFor } from '../registry/custom-modules';
import type { CustomFieldInfo, CustomModuleInfo } from '../registry/custom-modules';
import { SOURCE_LABELS } from '../registry/labels';
import { listLinkFor } from '../contracts/routes';
import { VIEW_CAPS, ViewActionRequestSchema } from '../contracts/views';
import type {
  AppLink, Cell, Column, DataTableBlock, FilterChip, KpiGroupBlock, NoticeBlock, Row, SectionState, SourceGroupBlock, SourceRef,
} from '../contracts/views';
import type { Cond, DateExpr, QueryPlan, RelRange } from '../contracts/plan';
import type { ComposedAnswer } from './compose';
import { chartWanted, composeCustomChart, withPresentNotice } from './chart';
import type { CustomGroupsOutcome, CustomListOutcome, CustomOutcome, CustomRecordRow } from '../query/execute-custom';
import { scrubIds } from './fallback-text';
import { andList, dayText, humanize, relRangeText } from './chips';
import { dayKeyFor } from '../../daily-events/daily-events.time';
import { zonedTimeToUtc } from '../../native-crm/shared/timezone';
import { isValidTimeZone, parseIsoCalendarDate } from '../../native-crm/shared/date-range';

/* Custom Module answers (Increment 5, LD5: executor M) as view blocks: a
 * table, a count tile, a count by a dropdown or yes/no field, and the states
 * around them (switched off, no access, not found, failed, too slow). The
 * blocks are the same kinds compose.ts builds for the built-in modules, with
 * their own source: key custom_module, scope 'all' and a note that these
 * records aren't limited per person (no DataScope exists for them). The
 * caller checks every reply with finalizeAnswer (compose.ts), as any other.
 *
 * Tables follow the module's own page: the record id ("ID"), the first six
 * fields of the definition that can be shown (email, phone, image, table,
 * category and rating fields never are; data.name or data.title always is),
 * and the creation date. Values are shown as stored: a dropdown option as
 * written, a number without a currency (none is stored), a yes/no never
 * touched as "No" (as the form shows it, and as a "no" condition counts it),
 * a relationship as the stored record number (never a name: no join, and no
 * 24-hex id is ever shown). A value in another shape is shown the way
 * conditions and sorts read it: a number written as text as that text, a
 * date-time written with an offset by the day it starts with. Rows link to
 * the module's list page only (there is no record page), built from the
 * route table (contracts/routes.ts listLinkFor). Chips use the ids the view
 * route removes ("w<i>", "search"); a table's handle re-runs on executor M.
 * The history summaries never carry a record value. */

/** What the composers need from the caller (compose.ts ComposeEnv: the tenant's timezone). */
export interface CustomComposeEnv { timezone: string }

/** The source note: there is no DataScope for Custom Module records. */
export const CUSTOM_SCOPE_NOTE = "Custom Module records aren't limited per person: everyone with access sees all of them";

/** The id of a list answer's table (as compose.ts's), kept on a view re-run. */
const TABLE_BLOCK_ID = 'b1-t';
const SOURCE = SOURCE_LABELS.custom_module;

/* ── Small helpers ─────────────────────────────────────────────────────── */

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Readable text, or null: ids are removed, objects are not text (as compose.ts textValue). */
function textValue(value: unknown, max = 300): string | null {
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

/** A number field's cell: a real number as a number. A number written as text
 * (older API data) is shown as that text: conditions and sorts read only real
 * numbers, so a table never shows as a number a value they skip. */
function numberCell(value: unknown): Cell {
  if (typeof value === 'number') return { t: 'number', v: Number.isFinite(value) ? value : null };
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return { t: 'text', v: textValue(value) };
  return { t: 'number', v: null };
}

function numberText(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function orList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

function timezoneOf(env: CustomComposeEnv): string {
  return isValidTimeZone(env.timezone) ? env.timezone : 'UTC';
}

function notice(id: string, code: string, text: string, tone: NoticeBlock['tone'] = 'info', extra: Partial<NoticeBlock> = {}): NoticeBlock {
  return { id, type: 'notice', tone, code, text: clip(scrubIds(text), 1000), ...extra };
}

/** The sort key a view action may send (ViewActionRequestSchema): a column whose key doesn't fit it is never sortable. */
const SortKeySchema = ViewActionRequestSchema.shape.sort.unwrap().shape.key;
const fitsSortKey = (key: string): boolean => SortKeySchema.safeParse(key).success;

/* ── Source and link ───────────────────────────────────────────────────── */

export function customSourceRef(info: CustomModuleInfo): SourceRef {
  return {
    key: 'custom_module',
    label: SOURCE,
    module: clip(info.key, 120),
    moduleLabel: clip(info.name, 120),
    scope: 'all',
    scopeNote: CUSTOM_SCOPE_NOTE,
  };
}

/** The module's list page, from the route table ("/native-crm/custom/:slug");
 * there is no record page. */
export function customListLink(info: CustomModuleInfo): AppLink | undefined {
  return listLinkFor(info.key);
}

/* ── Cells ─────────────────────────────────────────────────────────────── */

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/;
/** A local wall time as the date-time picker stores it (no offset). */
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** The calendar day a date field holds: its "YYYY-MM-DD" (the start of the
 * string, as conditions read it); a stored Date by its own calendar day. */
function dayOfValue(value: unknown, timezone: string): string | null {
  if (typeof value === 'string') {
    const m = DAY_PREFIX.exec(value.trim());
    return m && parseIsoCalendarDate(m[1]) ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dayKeyFor(value, 'date', timezone).key;
  return null;
}

/** A date-time field: a local wall time is the tenant's (the picker stores no
 * offset), shown as that instant; any other string by the day it starts with,
 * as a date (a bare day, or a value written with an offset by older API data:
 * conditions and sorts read it by that day, so its instant is never shown on
 * another day of the tenant's timezone). */
function datetimeCell(value: unknown, timezone: string): Cell {
  const none: Cell = { t: 'datetime', v: null, tz: clip(timezone, 64) };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? none : { t: 'datetime', v: value.toISOString(), tz: clip(timezone, 64) };
  if (typeof value !== 'string') return none;
  const raw = value.trim();
  const wall = WALL_TIME.exec(raw);
  if (wall && parseIsoCalendarDate(`${wall[1]}-${wall[2]}-${wall[3]}`) && Number(wall[4]) <= 23 && Number(wall[5]) <= 59) {
    const at = zonedTimeToUtc(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]), Number(wall[4]), Number(wall[5]), timezone);
    return Number.isNaN(at.getTime()) ? none : { t: 'datetime', v: at.toISOString(), tz: clip(timezone, 64) };
  }
  const day = dayOfValue(raw, timezone);
  return day ? { t: 'date', v: day } : none;
}

/** A yes/no value as the form shows it and conditions read it: true is yes;
 * false, '' (never touched), null and a missing key are no; a value of
 * another type is neither (an empty cell). */
function yesNoOf(value: unknown): boolean | null {
  if (value === true) return true;
  return value === false || value === '' || value === null || value === undefined ? false : null;
}

function cellFor(field: CustomFieldInfo, row: CustomRecordRow, timezone: string): Cell {
  if (field.system) return { t: 'date', v: row.createdAt ? dayKeyFor(row.createdAt, 'instant', timezone).key : null };
  const raw = row.data[field.fieldKey];
  switch (field.kind) {
    case 'number': return numberCell(raw);
    case 'boolean': return { t: 'bool', v: yesNoOf(raw) };
    case 'date': return { t: 'date', v: dayOfValue(raw, timezone) };
    case 'datetime': return datetimeCell(raw, timezone);
    // Text, a dropdown option as written, a multi-select's options joined,
    // a relationship's stored record number.
    default: return { t: 'text', v: textValue(raw) };
  }
}

/** The record's name: data.name, else data.title, else its record id. */
function titleOf(info: CustomModuleInfo, row: CustomRecordRow): string {
  for (const field of info.titleFields) {
    const text = textValue(row.data[field.fieldKey], 200);
    if (text) return text;
  }
  return textValue(row.recordId, 200) ?? info.singular;
}

/* ── Columns and rows ──────────────────────────────────────────────────── */

interface TableColumn { column: Column; cell: (row: CustomRecordRow) => Cell }

function columnOf(field: CustomFieldInfo, priority: 1 | 2 | 3): Column {
  const kind: Column['kind'] = field.system ? 'date'
    : field.kind === 'number' ? 'number'
      : field.kind === 'date' ? 'date'
        : field.kind === 'datetime' ? 'datetime'
          : field.kind === 'boolean' ? 'bool' : 'text';
  return {
    key: field.key, label: clip(field.label, 120), kind, align: kind === 'number' ? 'right' : 'left',
    sortable: field.sortable && fitsSortKey(field.key), priority,
  };
}

/** ID, the definition's table fields (CustomModuleInfo.columns), Created: at
 * most eight. The record's name is the priority-1 column (the record id when
 * it has none); the next two are priority 2, the rest 3. */
function tableColumns(info: CustomModuleInfo, timezone: string): TableColumn[] {
  const title = info.titleFields[0];
  const out: TableColumn[] = [{
    column: { key: 'recordId', label: 'ID', kind: 'text', align: 'left', sortable: false, priority: title ? 2 : 1 },
    cell: (row) => ({ t: 'text', v: textValue(row.recordId, 80) }),
  }];
  let twos = title ? 1 : 0;
  for (const field of info.columns) {
    let priority: 1 | 2 | 3 = 1;
    if (field !== title) {
      priority = twos < 2 ? 2 : 3;
      if (priority === 2) twos += 1;
    }
    out.push({ column: columnOf(field, priority), cell: (row) => cellFor(field, row, timezone) });
  }
  out.push({ column: columnOf(info.created, 3), cell: (row) => cellFor(info.created, row, timezone) });
  return out.slice(0, VIEW_CAPS.columns);
}

function rowFor(info: CustomModuleInfo, row: CustomRecordRow, columns: TableColumn[], link: AppLink | undefined, index: number): Row {
  const cells: Record<string, Cell> = {};
  for (const c of columns) cells[c.column.key] = c.cell(row);
  const number = textValue(row.recordId, 80);
  return {
    key: row.id ?? `r${index + 1}`,
    ...(row.id ? {
      entity: { module: clip(info.key, 120), id: row.id, ...(number ? { number } : {}), label: titleOf(info, row), source: 'custom_module' as const },
    } : {}),
    // No record page: a row opens the module's list.
    ...(link ? { href: link } : {}),
    cells,
  };
}

/* ── Chips and sentences ───────────────────────────────────────────────── */

type FieldCond = Extract<Cond, { f: string }>;

function isDateExpr(value: unknown): value is DateExpr {
  return !!value && typeof value === 'object' && ('date' in value || 'rel' in value);
}

/** "1 Nov 2026", "today", "the start of this week". */
function dateValueText(value: DateExpr): string {
  if ('date' in value) return dayText(value.date);
  if (value.rel === 'today' || value.rel === 'yesterday' || value.rel === 'tomorrow') return relRangeText(value.rel);
  return `the ${value.edge} of ${relRangeText(value.rel)}`;
}

/** "this week", "in the last 7 days". */
function relRangePhrase(range: RelRange): string {
  return /^(last|next)_\d+_days$/.test(range) ? `in the ${relRangeText(range)}` : relRangeText(range);
}

function valueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return numberText(value);
  if (isDateExpr(value)) return dateValueText(value);
  return clip(String(value ?? ''), 60);
}

/** The part of a field condition after its label: "more than 5", "this week", "includes Urgent". */
function fieldValueText(field: CustomFieldInfo | undefined, cond: FieldCond): string {
  const date = field?.kind === 'date' || field?.kind === 'datetime';
  const multi = field?.kind === 'multi';
  switch (cond.op) {
    case 'eq': return multi ? `includes ${valueText(cond.v)}` : valueText(cond.v);
    case 'ne': return multi ? `doesn't include ${valueText(cond.v)}` : `not ${valueText(cond.v)}`;
    case 'in': return `${multi ? 'includes ' : ''}${orList(cond.v.map(valueText))}`;
    case 'nin': return multi ? `includes none of ${cond.v.map(valueText).join(', ')}` : `not ${orList(cond.v.map(valueText))}`;
    case 'gt': return `${date ? 'after' : 'more than'} ${valueText(cond.v)}`;
    case 'gte': return `${date ? 'since' : 'at least'} ${valueText(cond.v)}`;
    case 'lt': return `${date ? 'before' : 'less than'} ${valueText(cond.v)}`;
    case 'lte': return `${date ? 'until' : 'at most'} ${valueText(cond.v)}`;
    case 'between': return date ? `${valueText(cond.v[0])} to ${valueText(cond.v[1])}` : `between ${valueText(cond.v[0])} and ${valueText(cond.v[1])}`;
    case 'within': return relRangeText(cond.v);
    case 'contains': return `contains "${clip(cond.v, 40)}"`;
    case 'empty': return 'not set';
    case 'not_empty': return 'set';
    default: return '';
  }
}

function labelOf(info: CustomModuleInfo, key: string): { field: CustomFieldInfo | undefined; label: string } {
  const field = customFieldFor(info, key);
  return { field, label: field?.label ?? humanize(key.split('.').pop() ?? key) };
}

/** One condition as a chip label: "Status: Done", "Visit date: this week". */
function conditionLabel(info: CustomModuleInfo, cond: Cond): string {
  if (!('f' in cond)) return clip(scrubIds(humanize(String(cond.v))), 120);
  const { field, label } = labelOf(info, cond.f);
  return clip(scrubIds(`${label}: ${fieldValueText(field, cond)}`), 120);
}

/** One condition as words after the module's name: "with status Done", "created this week". */
function conditionPhrase(info: CustomModuleInfo, cond: Cond): string {
  if (!('f' in cond)) return `that are ${humanize(String(cond.v)).toLowerCase()}`;
  const { field, label } = labelOf(info, cond.f);
  const name = label.toLowerCase();
  if (cond.op === 'empty') return `without ${name}`;
  if (cond.op === 'not_empty') return `with ${name} set`;
  if (cond.op === 'contains') return `with ${name} containing "${clip(cond.v, 40)}"`;
  const when = cond.op === 'within' ? relRangePhrase(cond.v) : fieldValueText(field, cond);
  if (field?.system) return `created ${when}`;
  if (field?.kind === 'date' || field?.kind === 'datetime') return `with ${name} ${when}`;
  if (field?.kind === 'boolean' && (cond.op === 'eq' || cond.op === 'ne')) {
    return `that are ${(cond.op === 'eq') === (cond.v === true) ? '' : 'not '}${name}`;
  }
  return `with ${name} ${fieldValueText(field, cond)}`;
}

/** The chips of a table or a count: one per where condition ("w<i>"), then the search. */
export function customFilterChips(info: CustomModuleInfo, plan: QueryPlan, removable: boolean): FilterChip[] {
  const chips: FilterChip[] = (plan.where ?? []).map((cond, i) => ({ id: `w${i}`, label: conditionLabel(info, cond), removable }));
  const search = plan.search?.trim();
  if (search) chips.push({ id: 'search', label: clip(scrubIds(`Search: "${clip(search, 60)}"`), 120), removable });
  return chips.slice(0, 20);
}

/** How the rows are ordered: newest first, or by a field. */
function sortPhrase(info: CustomModuleInfo, sort: { by: string; dir: 'asc' | 'desc' } | undefined): string {
  if (!sort || sort.by === info.created.key) return !sort || sort.dir === 'desc' ? 'newest first' : 'oldest first';
  const field = customFieldFor(info, sort.by);
  const label = (field?.label ?? sort.by).toLowerCase();
  if (field?.kind === 'date' || field?.kind === 'datetime') return `by ${label}, ${sort.dir === 'desc' ? 'latest first' : 'earliest first'}`;
  if (field?.kind === 'number') return `by ${label}, ${sort.dir === 'desc' ? 'highest first' : 'lowest first'}`;
  return sort.dir === 'desc' ? `by ${label}, Z to A` : `by ${label}`;
}

/** interpretedAs: "Site Visits with status Done, newest first", "Number of Site Visits, by status". */
function interpretCustomPlan(info: CustomModuleInfo, plan: QueryPlan, sort?: { by: string; dir: 'asc' | 'desc' }): string {
  const phrases = (plan.where ?? []).map((cond) => conditionPhrase(info, cond));
  const search = plan.search?.trim();
  if (search) phrases.push(`matching "${clip(search, 60)}"`);
  const conditions = phrases.length ? ` ${andList(phrases)}` : '';
  let text: string;
  if (plan.op === 'count') text = `Number of ${info.name}${conditions}`;
  else if (plan.op === 'aggregate') text = `Number of ${info.name}${conditions}, by ${labelOf(info, plan.group?.by ?? '').label.toLowerCase()}`;
  else text = `${info.name}${conditions}, ${sortPhrase(info, sort ?? plan.sort)}${plan.page && plan.page > 1 ? `, page ${plan.page}` : ''}`;
  return clip(scrubIds(text), 300);
}

/* ── One-line history summaries (no rows, no values) ──────────────────── */

const noun = (info: CustomModuleInfo, n: number) => (n === 1 ? info.singular : info.name);

export const customSummaries = {
  list: (info: CustomModuleInfo, shown: number, total: number) => (total === 0
    ? `No ${info.name} (${SOURCE}) to show.`
    : `Listed ${shown} of ${total} ${noun(info, total)} (${SOURCE}).`),
  count: (info: CustomModuleInfo, total: number | null) => (total === null
    ? `Couldn't count ${info.name} (${SOURCE}).`
    : `Counted ${total} ${noun(info, total)} (${SOURCE}).`),
  groups: (info: CustomModuleInfo, groups: number, total: number) => (groups === 0
    ? `No ${info.name} (${SOURCE}) to count.`
    : `Counted ${total} ${noun(info, total)} (${SOURCE}) in ${groups} ${groups === 1 ? 'group' : 'groups'}.`),
};

/* ── Answers ───────────────────────────────────────────────────────────── */

/** The table a list plan gives: chips for its conditions (removable: the
 * handle re-runs without them), the columns executor M can sort by, the sort
 * that ran, the page and the handle {plan, section, executor 'M'}. Used by the
 * chat answer and by the view route, which returns this block alone. A module
 * deleted since its definition was cached (result.moduleGone) gives a table
 * that says so: no zero, nothing to re-run, no link to its page. */
export function composeCustomTable(
  info: CustomModuleInfo, plan: QueryPlan, result: CustomListOutcome, env: CustomComposeEnv,
): { table: DataTableBlock; notices: NoticeBlock[]; interpretedAs: string } {
  const timezone = timezoneOf(env);
  const columns = tableColumns(info, timezone);
  const gone = result.moduleGone === true;
  const link = gone ? undefined : customListLink(info);
  const rows = result.items.slice(0, VIEW_CAPS.rows).map((row, i) => rowFor(info, row, columns, link, i));
  const filters = customFilterChips(info, plan, !gone);
  const interpretedAs = interpretCustomPlan(info, plan, result.sort);
  let state: SectionState = { status: 'ok' };
  if (gone) state = { status: 'unsupported', message: clip(scrubIds(goneText(info)), 500) };
  else if (!rows.length) {
    // The filters are repeated, so an empty answer says what was asked.
    const matched = filters.map((f) => f.label);
    const message = result.total > 0 ? `No more ${info.name} to show.`
      : matched.length ? `No ${info.name} match: ${matched.join(', ')}.` : `No ${info.name} yet.`;
    state = { status: 'empty', message: clip(scrubIds(message), 500) };
  }
  const size = Math.min(Math.max(result.size, 1), VIEW_CAPS.rows);
  const table: DataTableBlock = {
    id: TABLE_BLOCK_ID,
    type: 'data_table',
    title: clip(info.name, 200),
    source: customSourceRef(info),
    state,
    columns: columns.map((c) => c.column),
    rows,
    page: { index: result.page, size, total: gone ? null : result.total, hasMore: !gone && result.page * size < result.total },
    sort: { key: clip(result.sort.by, 80), dir: result.sort.dir },
    filters,
    interpretedAs,
    ...(gone ? {} : { handle: { plan, section: 'custom_module' as const, executor: 'M' as const } }),
    ...(link ? { listLink: link } : {}),
  };
  return { table, notices: [], interpretedAs };
}

/** A list answer: the table in a one-section source_group, as compose.ts composeList. */
export function composeCustomList(info: CustomModuleInfo, plan: QueryPlan, result: CustomListOutcome, env: CustomComposeEnv): ComposedAnswer {
  const { table, interpretedAs } = composeCustomTable(info, plan, result, env);
  const group: SourceGroupBlock = {
    id: 'b1', type: 'source_group', title: clip(info.name, 200),
    sections: [{ source: table.source, state: { status: 'ok' }, blocks: [table] }],
  };
  return { blocks: [group], summary: customSummaries.list(info, table.rows.length, result.total), interpretedAs, plan, dataRead: true };
}

/** The list a count drills into: the same module, conditions and search. */
function drillPlanOf(plan: QueryPlan): QueryPlan {
  return {
    v: 1, op: 'list', target: plan.target,
    ...(plan.where?.length ? { where: plan.where } : {}),
    ...(plan.search ? { search: plan.search } : {}),
  };
}

/** A count tile (null: couldn't be read, never shown as 0) whose drill handle
 * lists the same records on executor M; its hint names the conditions. */
export function composeCustomCount(info: CustomModuleInfo, plan: QueryPlan, total: number | null): ComposedAnswer {
  const chips = customFilterChips(info, plan, false);
  const href = customListLink(info);
  const kpi: KpiGroupBlock = {
    id: 'b1',
    type: 'kpi_group',
    title: clip(info.name, 200),
    items: [{
      key: clip(`${info.key}-count`, 80),
      label: clip(info.name, 120),
      source: customSourceRef(info),
      state: total === null ? { status: 'error', message: clip(`Couldn't read ${info.name} right now.`, 500), retryable: true } : { status: 'ok' },
      value: total === null ? null : { t: 'number', v: total },
      ...(chips.length ? { hint: clip(chips.map((c) => c.label).join('; '), 300) } : {}),
      drill: { plan: drillPlanOf(plan), section: 'custom_module', executor: 'M' },
      ...(href ? { href } : {}),
    }],
  };
  return { blocks: [kpi], summary: customSummaries.count(info, total), interpretedAs: interpretCustomPlan(info, plan), plan, dataRead: true };
}

function groupCell(key: string | null, field: CustomFieldInfo | undefined): Cell {
  if (key === null || key === '') return { t: 'text', v: 'Not set' };
  if (field?.kind === 'boolean') return { t: 'bool', v: key === 'true' ? true : key === 'false' ? false : null };
  return { t: 'text', v: textValue(key) };
}

/** A count per dropdown or yes/no value as a table [value, count], most
 * first; at most 25 rows (the rest is a partial state, row_cap); no handle. */
export function composeCustomGroups(info: CustomModuleInfo, plan: QueryPlan, result: CustomGroupsOutcome): ComposedAnswer {
  const field = plan.group ? customFieldFor(info, plan.group.by) : undefined;
  const filters = customFilterChips(info, plan, false);
  const interpretedAs = interpretCustomPlan(info, plan);
  const columns: Column[] = [
    { key: 'group', label: clip(field?.label ?? 'Value', 120), kind: field?.kind === 'boolean' ? 'bool' : 'text', align: 'left', sortable: false, priority: 1 },
    { key: 'count', label: clip(info.name, 120), kind: 'number', align: 'right', sortable: false, priority: 1 },
  ];
  const rows: Row[] = result.groups.slice(0, VIEW_CAPS.rows).map((g, i) => ({
    key: `g${i + 1}`,
    cells: { group: groupCell(g.key, field), count: { t: 'number', v: g.count } },
  }));
  const totalGroups = Math.max(result.totalGroups, rows.length);
  const capped = totalGroups > rows.length;
  const matched = filters.map((f) => f.label);
  const state: SectionState = rows.length === 0
    ? { status: 'empty', message: clip(scrubIds(matched.length ? `No ${info.name} match: ${matched.join(', ')}.` : `No ${info.name} to count yet.`), 500) }
    : capped ? { status: 'partial', partialReasons: ['row_cap'], message: `Showing ${rows.length} of ${totalGroups} groups.` }
      : { status: 'ok' };
  const link = customListLink(info);
  const table: DataTableBlock = {
    id: 'b1',
    type: 'data_table',
    title: clip(`${info.name} by ${(field?.label ?? 'value').toLowerCase()}`, 200),
    source: customSourceRef(info),
    state,
    columns,
    rows,
    page: { index: 1, size: VIEW_CAPS.rows, total: totalGroups, hasMore: capped },
    filters,
    interpretedAs,
    ...(link ? { listLink: link } : {}),
  };
  return { blocks: [table], summary: customSummaries.groups(info, totalGroups, result.total), interpretedAs, plan, dataRead: true };
}

/** The answer for what executeCustomPlan read; a module deleted since its
 * definition was cached is said to be gone, never answered with a zero.
 * Increment 8 (decision N20): a breakdown is a chart by the registry
 * modules' rules (views/chart.ts) unless a table was asked for; a list, a
 * count, or a breakdown asked as a pipeline says what it was shown as instead. */
export function composeCustomAnswer(info: CustomModuleInfo, plan: QueryPlan, outcome: CustomOutcome, env: CustomComposeEnv): ComposedAnswer {
  if (outcome.op === 'count' ? outcome.moduleGone : outcome.result.moduleGone) return composeCustomModuleMissing(info);
  if (outcome.op === 'list') return withPresentNotice(composeCustomList(info, plan, outcome.result, env), plan, 'table');
  if (outcome.op === 'count') return withPresentNotice(composeCustomCount(info, plan, outcome.total), plan, 'number');
  return chartWanted(plan) ? composeCustomChart(info, plan, outcome.result) : withPresentNotice(composeCustomGroups(info, plan, outcome.result), plan, 'table');
}

/* ── States: never a zero ──────────────────────────────────────────────── */

/** Custom Modules are switched off, or the caller lacks custom_modules.records.view
 * or custom_modules.definitions.view: an answer in that state. It names no
 * module: a caller who can't read the definitions never learns their names. */
export function composeCustomAccess(state: 'disabled' | 'no_permission'): ComposedAnswer {
  const text = state === 'disabled' ? `${SOURCE} are turned off for your company.` : `You don't have access to ${SOURCE}.`;
  return {
    blocks: [notice('b1', state === 'disabled' ? 'module_disabled' : 'no_permission', text, 'warning')],
    summary: state === 'disabled' ? `${SOURCE} are turned off for this company.` : `No access to ${SOURCE}.`,
    dataRead: false,
  };
}

/** What a module deleted since its definition was cached is answered with. */
function goneText(info: CustomModuleInfo): string {
  return `The Custom Module ${info.name} no longer exists. Check the Custom Modules in the sidebar.`;
}

/** The plan names a Custom Module the tenant doesn't have (deleted since, or
 * never there). With `info`: a module the cached definitions still had, which
 * a read just found deleted, is named as no longer there. */
export function composeCustomModuleMissing(info?: CustomModuleInfo): ComposedAnswer {
  return {
    blocks: [notice('b1', 'module_not_found', info ? goneText(info)
      : "I couldn't find that Custom Module. It may have been deleted; check the Custom Modules in the sidebar.", 'warning')],
    summary: info ? `${clip(info.name, 120)} (${SOURCE}) no longer exists.` : 'That Custom Module was not found.',
    dataRead: false,
  };
}

/** The read failed just now: an error notice, never a zero. */
export function composeCustomQueryFailed(info: CustomModuleInfo, plan: QueryPlan): ComposedAnswer {
  return {
    blocks: [notice('b1', 'query_failed', `Couldn't read ${info.name} right now.`, 'warning', { source: customSourceRef(info) })],
    summary: `Couldn't read ${info.name} (${SOURCE}).`,
    interpretedAs: interpretCustomPlan(info, plan),
    dataRead: false,
  };
}

/** The read didn't finish before the answer's deadline: retry later, never a zero. */
export function composeCustomTimedOut(info: CustomModuleInfo, plan: QueryPlan): ComposedAnswer {
  return {
    blocks: [notice('b1', 'query_timeout', `Reading ${info.name} took too long. Try again in a moment.`, 'warning')],
    summary: `Couldn't read ${info.name} (${SOURCE}) in time.`,
    interpretedAs: interpretCustomPlan(info, plan),
    dataRead: false,
  };
}
