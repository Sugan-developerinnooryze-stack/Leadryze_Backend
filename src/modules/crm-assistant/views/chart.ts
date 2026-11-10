import type { Cond, QueryPlan } from '../contracts/plan';
import type { FieldCap, ModuleCap } from '../registry/types';
import type { CustomModuleInfo } from '../registry/custom-modules';
import { customFieldFor } from '../registry/custom-modules';
import { getModuleCap } from '../registry';
import { isQueryGroupable, queryCapsFor } from '../registry/query-caps';
import { listLinkFor } from '../contracts/routes';
import { VIEW_CAPS } from '../contracts/views';
import type {
  AskAction, Cell, ChartBlock, ChartPoint, ChartTable, Column, DataTableBlock, NoticeBlock, Row, SectionState, SourceRef, ViewBlock,
} from '../contracts/views';
import type { MetricOutcome, MetricRow } from '../query/metrics';
import type { CustomGroupsOutcome } from '../query/execute-custom';
import type { Bucket, ChartGroupsOutcome } from '../query/aggregate';
import { MAX_CHART_POINTS, bucketEndOf, bucketStartOf, chartBuckets, windowOnField, withoutWindowOn } from '../query/aggregate';
import { resolveRelRange } from '../query/compile';
import type { ComposeEnv, ComposedAnswer, QueryRun } from './compose';
import {
  BUCKET_LABELS, chipContextFor, clip, composeGroups, composeMetric, humanize, isStatusField, metricTable, notice, planNotices,
  queryNoticeBlocks, relationPartialState, sourceRefFor, statusCell,
} from './compose';
import type { RelationWords } from './chips';
import { conditionPhrases, dayText, filterChips } from './chips';
import { interpretMetric, interpretPlan, lowerLabel } from './interpret';
import { scrubIds } from './fallback-text';
import { composeCustomGroups, customSourceRef } from './compose-custom';
import { isValidTimeZone } from '../../native-crm/shared/date-range';

/* Chart blocks (Increment 8): count breakdowns, named totals per currency
 * and Custom Module breakdowns drawn as one chart each, with their numbers
 * as a table, and the notice for a presentation an answer couldn't use.
 *
 * What is drawn (spec B1): a breakdown with at least 2 categories that have
 * records, or at least 2 date buckets, is a chart; fewer, or nothing read, is
 * today's table (composeGroups, composeMetric, composeCustomGroups), with a
 * notice when a chart was asked for. One measure per chart: a count, or money
 * in one currency (a named total is one chart per currency, never added or
 * ranked across currencies). Dates are every bucket of the window (an empty
 * one is 0, the read ran), else from the first to the last dated bucket, at
 * most 50, the ones nearest today; records with no date are never a point,
 * only a notice. Categories keep the read's biggest groups; a stage field
 * follows the tenant's pipeline order (peekStages), keys no longer in it after
 * (where the module groups case-insensitively, a key matches ignoring case).
 *
 * Every chart carries its numbers as a table (one row per point, keyed like
 * the point), a basis (what is counted or added up, by which date, the
 * cancelled rule) and a summary (its text alternative), written here from
 * what was drawn only: the total is the sum of the points shown, records off
 * the chart are named in the tails. Texts are spec B11.1's; labels never hold
 * a record id (scrubIds); no point drills (decision N18). A count by the
 * module's default or created date offers the other date as an ask action
 * (decision N19), a plan the server re-runs, never a named total's. */

type Kind = ChartBlock['kind'];
type Shape = 'dates' | 'categories' | 'ranking';

/** Past this many points dates are a line and categories horizontal bars. */
const MANY = 6;
/** A reply of charts keeps under this many bytes (decision N21; VIEW_CAPS.bytes is 256 KB). */
const MAX_REPLY_BYTES = 240 * 1024;
/** The point and table row key of records with no value. */
const NONE = '__none';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_WORDS: Readonly<Record<Kind, string>> = { bar: 'bar', hbar: 'horizontal bar', line: 'line' };
const KIND_NAMES: Readonly<Record<Kind, string>> = { bar: 'Bar', hbar: 'Horizontal bar', line: 'Line' };

/** One point and its table row. */
interface Item { x: string; label: string; y: number | null; cell: Cell }

/* ── Small helpers ─────────────────────────────────────────────────────── */

/** A presentation the user asked to see as a chart ("bar chart of ..."). */
function chartAsked(plan: QueryPlan): boolean {
  return plan.present === 'bar' || plan.present === 'hbar' || plan.present === 'line';
}

/** "scheduled date", "created date", "due date", "payment date": the date field's label, lower case. */
function dateWords(label: string): string {
  const lower = label.toLowerCase();
  return /date$/.test(lower) ? lower : `${lower} date`;
}

/** How a bucket's first day is shown: "3 Nov 2026", "Week of 2 Nov 2026", "Mar 2026", "Q1 2026", "2026". */
function bucketLabel(key: string, bucket: Bucket): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(key);
  if (!m) return key;
  const month = Number(m[2]);
  switch (bucket) {
    case 'day': return dayText(key);
    case 'week': return `Week of ${dayText(key)}`;
    case 'month': return `${MONTHS[month - 1] ?? m[2]} ${m[1]}`;
    case 'quarter': return `Q${Math.floor((month - 1) / 3) + 1} ${m[1]}`;
    default: return m[1];
  }
}

/** A title inside a sentence: lower case, except words in capitals ("in INR"). */
function titleWords(title: string): string {
  return title.split(' ').map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase())).join(' ');
}

/** Money in a sentence: "INR 2196.57". */
function moneyText(v: number, currency: string | null): string {
  return currency ? `${currency} ${v.toFixed(2)}` : v.toFixed(2);
}

/** A label people read: no record id, at most 120 characters; `fallback` when nothing is left. */
function safeLabel(text: string, fallback: string): string {
  return clip(scrubIds(text), 120) || clip(fallback, 120);
}

/** Point keys as sent: the stored value, or `k<n>` for one longer than a point key holds, unique in the series. */
function pointKeys(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  return raw.map((key, i) => {
    let x = key.length <= 80 ? key : `k${i + 1}`;
    for (let n = 2; seen.has(x); n += 1) x = `k${i + 1}-${n}`;
    seen.add(x);
    return x;
  });
}

/** The kind of chart (spec B1's rule), and what to say when the one asked for couldn't be drawn. */
function kindFor(plan: QueryPlan, points: number, shape: Shape): { kind: Kind; changed?: string } {
  const asked = plan.present;
  const many = points > MANY;
  if (shape === 'dates') {
    if (asked === 'line' || asked === 'bar') return { kind: asked };
    if (asked === 'hbar') return { kind: 'bar', changed: 'Dates read left to right, so this is shown as upright bars.' };
    return { kind: many ? 'line' : 'bar' };
  }
  if (shape === 'ranking') {
    if (asked === 'bar') return { kind: 'bar' };
    if (asked === 'line') return { kind: 'hbar', changed: 'A line chart needs dates, so this is shown as horizontal bars.' };
    return { kind: 'hbar' };
  }
  if (asked === 'hbar') return { kind: 'hbar' };
  // An upright bar chart of many categories is drawn with horizontal bars (both are bar charts: no notice).
  if (asked === 'line') return { kind: many ? 'hbar' : 'bar', changed: 'A line chart needs dates, so this is shown as bars.' };
  return { kind: many ? 'hbar' : 'bar' };
}

/** The chart's state: partial with `cut` (row_cap) when points were left out, else the relation's, else ok. */
function chartState(cut: string | null, relation: RelationWords | undefined): SectionState {
  const partial = relationPartialState(relation);
  if (!cut) return partial ?? { status: 'ok' };
  return {
    status: 'partial', partialReasons: ['row_cap', ...(partial?.partialReasons ?? [])],
    message: clip(`${cut}${partial?.message ? ` ${partial.message}` : ''}`, 500),
  };
}

/** The answer plus one more notice, with the first free id from `b<blocks + 1>`; unchanged when the reply's blocks are full. */
function withNotice(composed: ComposedAnswer, code: string, text: string): ComposedAnswer {
  if (composed.blocks.length >= VIEW_CAPS.blocks) return composed;
  const ids = new Set(composed.blocks.map((b) => b.id));
  let n = composed.blocks.length + 1;
  while (ids.has(`b${n}`)) n += 1;
  return { ...composed, blocks: [...composed.blocks, notice(`b${n}`, code, text)] };
}

const TOO_FEW = 'There is only one group to show, so this is shown as a table.';

/** Today's table for a breakdown that can't be a chart: with the chart_too_few notice when a chart was asked for and one group has records. */
function tooFew(composed: ComposedAnswer, plan: QueryPlan, groups: number): ComposedAnswer {
  return chartAsked(plan) && groups === 1 ? withNotice(composed, 'chart_too_few', TOO_FEW) : composed;
}

/** The highest and lowest point (the first of equals), nulls skipped. */
function extremes(points: readonly ChartPoint[]): { high?: ChartPoint; low?: ChartPoint; total: number } {
  let high: ChartPoint | undefined;
  let low: ChartPoint | undefined;
  let total = 0;
  for (const p of points) {
    if (p.y === null) continue;
    total += p.y;
    if (!high || p.y > high.y!) high = p;
    if (!low || p.y < low.y!) low = p;
  }
  return { high, low, total: Math.round(total * 100) / 100 };
}

/** Whether the plan reads only some statuses: a state, stage or outcome condition. */
function filtersStatus(cap: ModuleCap, plan: QueryPlan): boolean {
  const stage = cap.stage ? cap.fields.find((f) => f.path === cap.stage!.field || f.key === cap.stage!.field) : undefined;
  return (plan.where ?? []).some((cond) => cond.op === 'state' || cond.op === 'outcome'
    || ('f' in cond && !!stage && (cond.f === stage.key || cond.f === stage.path)));
}

/** A count chart's status sentence (a module with stages only). */
function statusSentence(cap: ModuleCap, plan: QueryPlan): string {
  if (!cap.stage) return '';
  return filtersStatus(cap, plan) ? ' Only the statuses in the filters are counted.' : ' Every status is counted, cancelled ones included.';
}

/** A window that cuts the first or last bucket drawn: what that bucket counts (money-6). */
function edgeSentences(keys: readonly string[], bucket: Bucket, window: { fromKey?: string; toKey?: string } | null): string {
  if (!window || !keys.length) return '';
  const first = keys[0];
  const last = keys[keys.length - 1];
  const parts: string[] = [];
  if (window.fromKey && first === bucketStartOf(window.fromKey, bucket) && window.fromKey !== first) {
    parts.push(` The first ${bucket} counts only from ${dayText(window.fromKey)}.`);
  }
  if (window.toKey && last === bucketStartOf(window.toKey, bucket) && window.toKey !== bucketEndOf(last, bucket)) {
    parts.push(` The last ${bucket} counts only up to ${dayText(window.toKey)}.`);
  }
  return parts.join('');
}

/** A date chart's range: the window's ends, else the first and last dated bucket the read found. */
function rangeOf(
  window: { fromKey?: string; toKey?: string } | null, span: { lo: string; hi: string } | null | undefined,
): { fromKey?: string; toKey?: string } | null {
  const fromKey = window?.fromKey ?? span?.lo;
  const toKey = window?.toKey ?? span?.hi;
  return fromKey || toKey ? { ...(fromKey ? { fromKey } : {}), ...(toKey ? { toKey } : {}) } : null;
}

/** The state text of a date chart cut to the buckets nearest today; `total` null when the range isn't known. */
function datesCutText(shown: number, bucket: Bucket, total: number | null): string {
  return total === null
    ? `Showing the ${shown} ${bucket}s nearest today; ${bucket}s further away are not on the chart.`
    : `Showing the ${shown} ${bucket}s nearest today of ${total}.`;
}

/** "Bar chart of tickets by priority: 4 groups, 31 tickets in all. Most: High with 12. Fewest: Low with 2." */
function categoriesSummary(kind: Kind, title: string, points: readonly ChartPoint[], plural: string, cut: boolean): string {
  const { high, low, total } = extremes(points);
  const head = `${KIND_NAMES[kind]} chart of ${titleWords(title)}: ${points.length} groups, ${total} ${plural} ${cut ? `in the ${points.length} shown` : 'in all'}.`;
  return high && low ? `${head} Most: ${high.label} with ${high.y}. Fewest: ${low.label} with ${low.y}.` : head;
}

/** "Line chart of work orders per month by scheduled date, Jan 2026 to Dec 2026: 72 in all. Highest: ... Lowest: ...". */
function datesSummary(kind: Kind, title: string, points: readonly ChartPoint[], cut: boolean, value: (v: number) => string): string {
  const { high, low, total } = extremes(points);
  const range = points.length ? `, ${points[0].label} to ${points[points.length - 1].label}` : '';
  const head = `${KIND_NAMES[kind]} chart of ${titleWords(title)}${range}: ${value(total)} ${cut ? `in the ${points.length} shown` : 'in all'}.`;
  return high && low ? `${head} Highest: ${high.label} with ${value(high.y!)}. Lowest: ${low.label} with ${value(low.y!)}.` : head;
}

/** The undated tail of a summary: " 2 work orders with no scheduled date are not on the chart." */
function undatedTail(n: number | null | undefined, cap: { singular: string; plural: string }, words: string): string {
  if (!n) return '';
  return n === 1
    ? ` 1 ${lowerLabel(cap.singular)} with no ${words} is not on the chart.`
    : ` ${n} ${lowerLabel(cap.plural)} with no ${words} are not on the chart.`;
}

/** The ChartTable of a chart: the table's own columns, cells and words, one row per point (keyed like it), all on page 1. */
function chartTable(table: DataTableBlock, items: readonly Item[] | null, rowKeys: readonly string[], state: SectionState, total: number | null, cut: boolean): ChartTable {
  const { handle: _handle, page: _page, ...rest } = table;
  const rows: Row[] = items
    ? items.map((item) => ({ key: item.x, cells: { group: item.cell, count: { t: 'number', v: item.y } } }))
    : table.rows.map((row, i) => ({ ...row, key: rowKeys[i] ?? row.key }));
  return { ...rest, rows, state, page: { index: 1, size: Math.max(1, rows.length), total, hasMore: cut } };
}

/** The answer's blocks: the charts, then `notes` as notices from `b2`, within the reply's blocks. */
function withNotes(charts: ViewBlock[], own: ReadonlyArray<{ code: string; text: string }>, source: SourceRef, more: NoticeBlock[]): ViewBlock[] {
  const notes = own.map((n, i) => notice(`b${2 + i}`, n.code, n.text, 'info', { source }));
  return [...charts, ...notes, ...more].slice(0, VIEW_CAPS.blocks);
}

/* ── Which answers are charts ──────────────────────────────────────────── */

/** A count or named-total breakdown read for a chart: op 'aggregate' with a group and present not 'table', 'kpi' or 'pipeline'. */
export function chartWanted(plan: QueryPlan): boolean {
  return plan.op === 'aggregate' && !!plan.group && plan.present !== 'table' && plan.present !== 'kpi' && plan.present !== 'pipeline';
}

/** The answer plus the notice for a presentation it couldn't use (B1): chart words on a list or a number, 'pipeline' off a stage breakdown. */
export function withPresentNotice(composed: ComposedAnswer, plan: QueryPlan, shownAs: 'table' | 'number'): ComposedAnswer {
  const shown = shownAs === 'table' ? 'a table' : 'a number';
  if (chartAsked(plan)) {
    return withNotice(composed, 'chart_needs_breakdown', `A chart needs a breakdown, such as per month or by status, so this is shown as ${shown}.`);
  }
  if (plan.present === 'pipeline') {
    return withNotice(composed, 'chart_pipeline_needs_stage',
      `A pipeline view needs a count of deals, leads, tasks, tickets, work orders, quotations, contracts or invoices by stage, so this is shown as ${shown}.`);
  }
  return composed;
}

/* ── Count charts ──────────────────────────────────────────────────────── */

/** The date switch (decision N19): a count by the module's default date gets
 * "By created date", one by its created date "By <default date>", when the
 * other date differs and can be counted by: the same plan grouped by it, its
 * windows on the old date moved onto it (same operator and value). */
function dateSwitch(cap: ModuleCap, plan: QueryPlan, field: FieldCap): AskAction | undefined {
  const { default: byDefault, created } = cap.dates;
  const other = field.key === byDefault && created !== byDefault ? created
    : field.key === created && byDefault !== created ? byDefault : undefined;
  const target = other ? cap.fields.find((f) => f.key === other) : undefined;
  if (!target || (target.kind !== 'date' && target.kind !== 'datetime') || !isQueryGroupable(cap, target) || !plan.group) return undefined;
  const kept = new Set<Cond>(withoutWindowOn(plan, field.key).where ?? []);
  const where = plan.where?.map((cond) => (kept.has(cond) ? cond : { ...cond, f: target.key } as Cond));
  return {
    kind: 'ask',
    label: clip(`By ${dateWords(target.label)}`, 120),
    plan: { ...plan, ...(where ? { where } : {}), group: { ...plan.group, by: target.key } },
  };
}

/** A count breakdown (executeChartGroups) as a chart, or composeGroups' table
 * when nothing was read or fewer than 2 points (dates) or categories with
 * records (fields) are left: with chart_too_few when a chart was asked for. */
export function composeCountChart(cap: ModuleCap, plan: QueryPlan, outcome: ChartGroupsOutcome, env: ComposeEnv, relation?: RelationWords): ComposedAnswer {
  const table = () => composeGroups(cap, plan, outcome, env, relation);
  const group = plan.group;
  // Nothing read: today's empty table says so (never a chart of zeros).
  if (!group || outcome.total === 0 || !outcome.groups.some((g) => g.count > 0)) return table();
  const field = cap.fields.find((f) => f.key === group.by || f.path === group.by);
  const source = sourceRefFor(cap, env.scopeKind);
  const run: QueryRun = { executor: 'Q', implied: outcome.implied, notices: outcome.notices };
  const chipCtx = chipContextFor(outcome.read, run);
  const plural = lowerLabel(cap.labels.plural);
  const singular = lowerLabel(cap.labels.singular);
  const timezone = isValidTimeZone(env.timezone) ? env.timezone : 'UTC';
  const bucket = (outcome.bucket ?? group.bucket) as Bucket | undefined;
  const own: Array<{ code: string; text: string }> = [];

  let items: Item[];
  let shape: Shape;
  let cut: string | null = null;
  let pageTotal: number | null;
  let title: string;
  let xLabel: string;
  let basis: string;
  let tail = '';
  let actions: AskAction[] = [];
  let groupKind: Column['kind'];

  if (bucket) {
    shape = 'dates';
    const words = dateWords(field?.label ?? group.by);
    const counts = new Map<string, number>();
    for (const g of outcome.groups) if (g.key && DAY_KEY.test(g.key)) counts.set(g.key, (counts.get(g.key) ?? 0) + g.count);
    const window = outcome.window;
    const span = outcome.datedSpan;
    const buckets = chartBuckets([...counts.keys()], bucket, rangeOf(window, span), outcome.todayKey, MAX_CHART_POINTS, {
      stopAtToday: !!field && field.key === cap.dates.created,
    });
    items = buckets.keys.map((key) => {
      const label = bucketLabel(key, bucket);
      return { x: key, label, y: counts.get(key) ?? 0, cell: { t: 'text', v: label } };
    });
    if (items.length < 2) return tooFew(table(), plan, items.length);
    // The read itself kept only the buckets nearest today: how many there are is known from the range's ends.
    const trimmed = outcome.bucketsKept === 'nearest';
    const known = !trimmed || (!!window?.fromKey && !!window?.toKey) || !!span;
    pageTotal = known ? buckets.total : null;
    if (buckets.cut || trimmed) cut = datesCutText(items.length, bucket, pageTotal);
    title = `${cap.labels.plural} per ${bucket} by ${words}`;
    xLabel = BUCKET_LABELS[bucket] ?? humanize(bucket);
    const edges = edgeSentences(buckets.keys, bucket, window);
    basis = `Counts ${plural} by ${words}, per calendar ${bucket} in ${timezone} time.${bucket === 'week' ? ' Weeks start on Monday.' : ''}`
      + `${statusSentence(cap, plan)}${edges}`;
    // Records with no date: never a point. With a window, the parallel count (a
    // field flagged undatedNotice says it in executor Q's own note); without
    // one, the read's no-date group.
    const undated = window
      ? ('undatedOutside' in outcome ? outcome.undatedOutside : undefined)
      : outcome.undatedGroup ?? outcome.groups.filter((g) => g.key === null || g.key === '').reduce((n, g) => n + g.count, 0);
    if (window && 'undatedOutside' in outcome) {
      if (undated === null || undated === undefined) own.push({ code: 'undated_left_out', text: `${cap.labels.plural} with no ${words} are in no ${bucket}.` });
      else if (undated > 0) {
        own.push({
          code: 'undated_left_out',
          text: undated === 1 ? `1 ${singular} has no ${words}, so no ${bucket} includes it.` : `${undated} ${plural} have no ${words}, so no ${bucket} includes them.`,
        });
      }
    } else if (!window && undated) {
      own.push({
        code: 'undated_left_out',
        text: undated === 1 ? `1 ${singular} has no ${words}, so it is not on the chart.` : `${undated} ${plural} have no ${words}, so they are not on the chart.`,
      });
    }
    tail = `${undatedTail(undated, cap.labels, words)}${cut ? ` ${cut}` : ''}${edges}`;
    groupKind = 'text';
    const switched = field ? dateSwitch(cap, plan, field) : undefined;
    if (switched) actions = [switched];
  } else {
    shape = 'categories';
    const status = outcome.read.status;
    const isStatus = !!field && isStatusField(field, status);
    const isBool = field?.kind === 'boolean';
    // Where the module groups case-insensitively (leads), a stored stage value is
    // the stage key it equals ignoring case (query/pipeline.ts stageKeyReader;
    // the first in pipeline order), its count merged into that stage's.
    const ignoreCase = isStatus && !!queryCapsFor(cap.key)?.collation;
    const byLower = new Map<string, string>();
    if (ignoreCase) for (const key of status?.options.keys() ?? []) if (!byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), key);
    const stageKeyOf = (key: string): string => (!ignoreCase || status?.options.has(key) ? key : byLower.get(key.toLowerCase()) ?? key);
    // Records with no value, stored as null or '': one "Not set" point (one x per series).
    const merged = new Map<string, number>();
    let noneGroups = 0;
    let folded = 0;
    for (const g of outcome.groups.slice(0, MAX_CHART_POINTS)) {
      const key = g.key === null || g.key === '' ? NONE : stageKeyOf(g.key);
      if (key === NONE) noneGroups += 1;
      else if (ignoreCase && merged.has(key)) folded += 1;
      merged.set(key, (merged.get(key) ?? 0) + g.count);
    }
    const labelOf = (key: string): string => {
      if (key === NONE) return 'Not set';
      if (isStatus) return safeLabel(status?.options.get(key)?.label ?? humanize(key), field?.label ?? 'Status');
      if (isBool) return key === 'true' ? 'Yes' : key === 'false' ? 'No' : safeLabel(humanize(key), field?.label ?? 'Value');
      return safeLabel(humanize(key), field?.label ?? 'Value');
    };
    const entries = [...merged].map(([key, count]) => ({ key, count, label: labelOf(key) }));
    const byCount = (a: { key: string; count: number; label: string }, b: { key: string; count: number; label: string }) =>
      b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    let ordered: typeof entries;
    const removed: typeof entries = [];
    if (isStatus) {
      // The tenant's pipeline order (peekStages, inactive stages in their place), then keys no longer in it, then "Not set".
      const order = [...(status?.options.keys() ?? [])];
      const known = entries.filter((e) => e.key !== NONE && status?.options.has(e.key))
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      removed.push(...entries.filter((e) => e.key !== NONE && !status?.options.has(e.key))
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
      ordered = [...known, ...removed, ...entries.filter((e) => e.key === NONE)];
    } else if (isBool) {
      const rank = (key: string) => (key === 'true' ? 0 : key === 'false' ? 1 : key === NONE ? 3 : 2);
      ordered = [...entries].sort((a, b) => rank(a.key) - rank(b.key) || byCount(a, b));
    } else {
      ordered = [...entries.filter((e) => e.key !== NONE).sort(byCount), ...entries.filter((e) => e.key === NONE)];
    }
    const xs = pointKeys(ordered.map((e) => e.key));
    items = ordered.map((e, i) => ({
      x: xs[i], label: e.label, y: e.count,
      cell: e.key === NONE ? { t: 'text', v: 'Not set' }
        : isStatus ? statusCell(e.key, status)
          : isBool ? { t: 'bool', v: e.key === 'true' ? true : e.key === 'false' ? false : null }
            : { t: 'text', v: e.label },
    }));
    if (items.length < 2) return tooFew(table(), plan, items.length);
    const totalGroups = Math.max(outcome.totalGroups - Math.max(0, noneGroups - 1) - folded, items.length);
    pageTotal = totalGroups;
    if (totalGroups > items.length) cut = `Showing the ${items.length} biggest groups of ${totalGroups}.`;
    const fieldWords = lowerLabel(field?.label ?? group.by);
    title = `${cap.labels.plural} by ${fieldWords}`;
    xLabel = field?.label ?? humanize(group.by);
    const pipeline = !!cap.stage && 'pipeline' in cap.stage;
    basis = `Counts ${plural} by ${fieldWords}.${statusSentence(cap, plan)}`
      + `${isStatus && pipeline ? ` Stage names and order come from your ${singular} pipeline settings.` : ''}`;
    // A stored stage key the pipeline no longer has: its own category after the pipeline's, named here (pipeline modules only).
    if (isStatus && pipeline && removed.length) {
      const n = removed.reduce((sum, e) => sum + e.count, 0);
      const names = removed.slice(0, 5).map((e) => clip(humanize(e.key), 60));
      const more = removed.length > 5 ? ` and ${removed.length - 5} more` : '';
      own.push({
        code: 'removed_stages',
        text: n === 1 ? `1 ${singular} is in a stage no longer in your pipeline: ${names.join(', ')}${more}.`
          : `${n} ${plural} are in stages no longer in your pipeline: ${names.join(', ')}${more}.`,
      });
    }
    tail = cut ? ` ${cut}` : '';
    groupKind = isStatus ? 'status' : isBool ? 'bool' : 'text';
  }

  const { kind, changed } = kindFor(plan, items.length, shape);
  if (changed) own.push({ code: 'chart_kind_changed', text: changed });
  const state = chartState(cut, relation);
  const points: ChartPoint[] = items.map((item) => ({ x: item.x, label: item.label, y: item.y }));
  const filters = filterChips(cap, plan, chipCtx, false, relation);
  const interpretedAs = clip(interpretPlan(plan, cap, env.scopeKind, { conditions: conditionPhrases(cap, plan, chipCtx, relation) }), 300);
  const listLink = listLinkFor(cap.key);
  const shownTitle = clip(title, 200);
  const columns: Column[] = [
    { key: 'group', label: clip(xLabel, 120), kind: groupKind, align: 'left', sortable: false, priority: 1 },
    { key: 'count', label: clip(cap.labels.plural, 120), kind: 'number', align: 'right', sortable: false, priority: 1 },
  ];
  const base: DataTableBlock = {
    id: 'b1-t', type: 'data_table', title: shownTitle, source, state, columns, rows: [],
    page: { index: 1, size: 1, total: null, hasMore: false }, filters, interpretedAs, ...(listLink ? { listLink } : {}),
  };
  const summary = shape === 'dates'
    ? datesSummary(kind, title, points, !!cut, (v) => String(v))
    : categoriesSummary(kind, title, points, plural, !!cut);
  const chart: ChartBlock = {
    id: 'b1',
    type: 'chart',
    title: shownTitle,
    kind,
    state,
    x: { label: clip(xLabel, 120), kind: bucket ?? 'category' },
    y: { kind: 'count', label: clip(cap.labels.plural, 120) },
    series: [{ key: clip(cap.key, 80), label: clip(cap.labels.plural, 120), source, points }],
    basis: clip(scrubIds(basis), 500),
    summary: clip(scrubIds(`${summary}${tail}`), 500),
    table: chartTable(base, items, [], state, pageTotal, !!cut),
    ...(actions.length ? { actions } : {}),
  };
  const notes = queryNoticeBlocks([...outcome.notices, ...planNotices(cap, plan)], source, 'b', 2 + own.length);
  return {
    blocks: withNotes([chart], own, source, notes),
    summary: `Showed a ${KIND_WORDS[kind]} chart of ${plural} in ${items.length} ${bucket ? `${bucket}s` : 'groups'}.`,
    interpretedAs,
    plan,
    dataRead: true,
  };
}

/* ── Named-total charts ────────────────────────────────────────────────── */

/** A named total's breakdown (executeQueryMetric) as one chart per currency,
 * the caller's currency first: a ranking (purchase amount per customer,
 * pipeline value by stage) as horizontal bars, largest first; a total by its
 * own date (payments received per month) zero-filled like a count by date.
 * Nothing matched, or fewer than 2 points in the first currency's chart:
 * composeMetric's answer (with chart_too_few when a chart was asked for and
 * one point was there). Each chart carries the metric's basis; its table is
 * metricTable's, keyed like the points. Charts that don't fit the reply's
 * blocks or 240 KB are left out whole and named (more_currencies). */
export function composeMetricCharts(
  cap: ModuleCap, plan: QueryPlan, outcome: MetricOutcome, env: ComposeEnv, labels: ReadonlyMap<string, string>, relation?: RelationWords,
): ComposedAnswer {
  const metric = outcome.metric;
  const table = () => composeMetric(cap, plan, outcome, env, labels, relation);
  const group = plan.group;
  const sections = outcome.groupsByCurrency ?? [];
  if (!group || !sections.length) return table();
  const bucket = (outcome.bucket ?? group.bucket) as Bucket | undefined;
  const field = cap.fields.find((f) => f.key === group.by || f.path === group.by);
  const fieldWords = lowerLabel(field?.label ?? group.by);
  const source = sourceRefFor(cap, env.scopeKind);
  const run: QueryRun = { executor: 'Q', implied: outcome.implied, notices: outcome.notices };
  const chipCtx = chipContextFor(outcome.read, run);
  const chips = filterChips(cap, plan, chipCtx, false, relation);
  const interpretedAs = clip(interpretMetric(plan, cap, env.scopeKind, metric.label, {
    conditions: conditionPhrases(cap, plan, chipCtx, relation), per: bucket ?? field?.label ?? group.by,
    ...(metric.currency ? { ownCurrency: true } : {}),
  }), 300);
  const shared = { chips, interpretedAs, ...(relation ? { relation } : {}) };
  // The read's clock (executeQueryMetric), never the wall clock: the window and today's bucket agree with what was read.
  const tz = isValidTimeZone(env.timezone) ? env.timezone : 'UTC';
  const clock = outcome.clock ?? (() => {
    const now = new Date();
    return { timezone: tz, now, todayKey: resolveRelRange('today', tz, now).fromKey };
  })();
  const dateField = metric.bucketField ? cap.fields.find((f) => f.key === metric.bucketField) : undefined;
  const words = dateWords(dateField?.label ?? metric.bucketField ?? 'date');
  const window = bucket && metric.bucketField ? windowOnField(plan, metric.bucketField, clock.timezone, clock.now) : null;
  const several = sections.length > 1;
  const named = (currency: string | null) => currency ?? 'an unrecorded currency';
  const isStage = !bucket && !!field && isStatusField(field, outcome.read.status);
  const refModule = bucket ? undefined : field?.ref?.module;
  const refName = refModule ? getModuleCap(refModule)?.labels.singular : undefined;
  const refLink = refModule && env.canViewModule(refModule) ? listLinkFor(refModule) : undefined;
  /** A ranking's group cell: metricTable's, with no record id in its words (a key that is one reads as the module's name). */
  const rankingCell = (row: MetricRow): Cell => {
    if (row.key === null) return { t: 'text', v: `No ${fieldWords}` };
    if (isStage) return statusCell(row.key, outcome.read.status);
    if (!refModule) return { t: 'text', v: clip(scrubIds(row.key), 300) || null };
    const name = labels.get(row.key);
    const number = clip(scrubIds(row.key), 80);
    return {
      t: 'ref', label: clip(scrubIds(name ?? row.key), 200) || refName || field?.label || 'Record',
      ...(name && name !== row.key && number ? { number } : {}),
      ...(refLink ? { href: refLink } : {}),
    };
  };
  let undatedRecords = 0;

  interface Built { chart: ChartBlock; kind: Kind; changed?: string; points: number }
  const build = (section: MetricOutcome['groupsByCurrency'][number], index: number): Built | null => {
    const currency = section.currency;
    const rows = several ? outcome.rows.filter((row) => row.currency === currency) : outcome.rows;
    const value = (v: number) => moneyText(v, currency ? clip(currency, 8) : null);
    let pointRows: MetricRow[];
    let points: ChartPoint[];
    let cut: string | null = null;
    let pageTotal: number | null;
    let tail = '';
    let basis = metric.basis;
    let shape: Shape;
    if (bucket) {
      shape = 'dates';
      const dated = rows.filter((row) => row.key !== null && DAY_KEY.test(row.key));
      const noDate = rows.filter((row) => row.key === null);
      const byKey = new Map(dated.map((row) => [row.key!, row]));
      const buckets = chartBuckets([...byKey.keys()], bucket, rangeOf(window, section.span), clock.todayKey, MAX_CHART_POINTS);
      pointRows = buckets.keys.map((key) => byKey.get(key) ?? { key, currency, value: 0, count: 0 });
      points = pointRows.map((row) => ({ x: row.key!, label: bucketLabel(row.key!, bucket), y: row.value }));
      // This currency's read kept only the buckets nearest today (plus its no-date row).
      const trimmed = section.groups > dated.length + (noDate.length ? 1 : 0);
      const known = !trimmed || (!!window?.fromKey && !!window?.toKey) || !!section.span;
      pageTotal = known ? buckets.total : null;
      if (buckets.cut || trimmed) cut = datesCutText(points.length, bucket, pageTotal);
      const undated = window ? 0 : noDate.reduce((n, row) => n + row.count, 0);
      undatedRecords += undated;
      const edges = edgeSentences(buckets.keys, bucket, window);
      basis = `${metric.basis} Grouped per calendar ${bucket} of the ${words}, in ${clock.timezone} time.${edges}`;
      tail = `${undatedTail(undated, cap.labels, words)}${cut ? ` ${cut}` : ''}${edges}`;
    } else {
      shape = 'ranking';
      // Records with no value (key null, stored null or ''): one point, its total the sum (null if any part is), then re-ranked.
      const none = rows.filter((row) => row.key === null);
      pointRows = rows.filter((row) => row.key !== null);
      if (none.length) {
        const unread = none.some((row) => row.value === null);
        const sum = none.reduce((n, row) => n + (row.value ?? 0), 0);
        pointRows.push({ key: null, currency, value: unread ? null : Math.round(sum * 100) / 100, count: none.reduce((n, row) => n + row.count, 0) });
        pointRows.sort((a, b) => (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0)
          || ((a.key ?? '') < (b.key ?? '') ? -1 : (a.key ?? '') > (b.key ?? '') ? 1 : 0));
      }
      const groups = Math.max(section.groups - Math.max(0, none.length - 1), pointRows.length);
      const xs = pointKeys(pointRows.map((row) => row.key ?? NONE));
      points = pointRows.map((row, i) => {
        const key = row.key;
        const chosen = key === null ? `No ${fieldWords}`
          : isStage ? outcome.read.status?.options.get(key)?.label ?? humanize(key)
            : refModule ? labels.get(key) ?? key : key;
        return { x: xs[i], label: safeLabel(chosen, key === null ? `No ${fieldWords}` : refName ?? field?.label ?? 'Value'), y: row.value };
      });
      pageTotal = groups;
      if (groups > points.length) cut = `Top ${points.length} of ${groups}.`;
    }
    if (!points.length) return null;
    const { kind, changed } = kindFor(plan, points.length, shape);
    const id = index === 0 ? 'b1' : `b1-${index + 1}`;
    const title = clip(`${bucket ? `${metric.label} per ${bucket}` : `${metric.label} by ${fieldWords}`}${several ? ` in ${named(currency)}` : ''}`, 200);
    const state = chartState(cut, relation);
    const metricRows = metricTable(cap, plan, outcome, env, labels, {
      id: `${id}-t`, title, rows: pointRows, groups: pageTotal ?? pointRows.length, maxRows: MAX_CHART_POINTS,
      groupCell: bucket ? (row: MetricRow): Cell => ({ t: 'text', v: bucketLabel(row.key ?? '', bucket) }) : rankingCell,
    }, shared);
    let summary: string;
    if (bucket) summary = `${datesSummary(kind, title, points, !!cut, value)}${tail}`;
    else {
      const { high, low } = extremes(points);
      summary = `${KIND_NAMES[kind]} chart of ${titleWords(title)}`
        + `${high && low ? `: highest ${high.label} (${value(high.y!)}), lowest shown ${low.label} (${value(low.y!)})` : ''}.${cut ? ` ${cut}` : ''}`;
    }
    const chart: ChartBlock = {
      id,
      type: 'chart',
      title,
      kind,
      state,
      x: { label: clip(bucket ? BUCKET_LABELS[bucket] ?? humanize(bucket) : field?.label ?? humanize(group.by), 120), kind: bucket ?? 'category' },
      y: { kind: 'money', label: clip(metric.label, 120), currency: currency ? clip(currency, 8) : null },
      series: [{ key: clip(`${cap.key}-${currency ?? 'none'}`, 80), label: clip(metric.label, 120), source, points }],
      basis: clip(scrubIds(basis), 500),
      summary: clip(scrubIds(summary), 500),
      table: chartTable(metricRows, null, points.map((p) => p.x), state, pageTotal, !!cut),
    };
    return { chart, kind, ...(changed ? { changed } : {}), points: points.length };
  };

  const first = build(sections[0], 0);
  // Decided on the caller's currency: fewer than 2 points there is today's table for every currency.
  if (!first || first.points < 2) return tooFew(table(), plan, first?.points ?? 0);
  const built = [first, ...sections.slice(1).map((s, i) => build(s, i + 1))];
  const own: Array<{ code: string; text: string }> = [];
  if (undatedRecords > 0) {
    own.push({
      code: 'undated_left_out',
      text: undatedRecords === 1 ? `1 ${lowerLabel(cap.labels.singular)} has no ${words}, so it is not on the chart.`
        : `${undatedRecords} ${lowerLabel(cap.labels.plural)} have no ${words}, so they are not on the chart.`,
    });
  }
  if (first.changed) own.push({ code: 'chart_kind_changed', text: first.changed });
  const notes = [...outcome.notices, ...planNotices(cap, plan)];
  // As many charts as the reply's blocks hold (composeMetric's rule), then whole charts out until it fits 240 KB.
  const charted = built.map((b, i) => ({ b, section: sections[i] })).filter((c): c is { b: Built; section: typeof sections[number] } => c.b !== null);
  const room = VIEW_CAPS.blocks - own.length - notes.length;
  let fit = charted.length <= room ? charted.length : Math.max(1, room - 1);
  const blocksFor = (n: number): ViewBlock[] => {
    const left = sections.filter((s) => !charted.slice(0, n).some((c) => c.section === s) && charted.some((c) => c.section === s));
    const after = queryNoticeBlocks(notes, source, 'b', 2 + own.length);
    const more = left.length
      ? [notice(`b${2 + own.length + after.length}`, 'more_currencies',
        `${metric.label} in ${left.length} more ${left.length === 1 ? 'currency' : 'currencies'} (${left.map((s) => named(s.currency)).join(', ')}) is not shown here.`,
        'info', { source })]
      : [];
    return withNotes(charted.slice(0, n).map((c) => c.b.chart), own, source, [...after, ...more]);
  };
  let blocks = blocksFor(fit);
  while (fit > 1 && Buffer.byteLength(JSON.stringify(blocks)) > MAX_REPLY_BYTES) {
    fit -= 1;
    blocks = blocksFor(fit);
  }
  const kind = first.kind;
  return {
    blocks,
    summary: fit === 1
      ? `Showed ${lowerLabel(metric.label)} as a ${KIND_WORDS[kind]} chart.`
      : `Showed ${lowerLabel(metric.label)} as ${KIND_WORDS[kind]} charts in ${fit} currencies.`,
    interpretedAs,
    plan,
    dataRead: true,
  };
}

/* ── Custom Module charts ──────────────────────────────────────────────── */

/** A chart, or composeCustomGroups' table (plus chart_too_few when a chart was asked for and fewer than 2 values have records). */
export function composeCustomChart(info: CustomModuleInfo, plan: QueryPlan, result: CustomGroupsOutcome): ComposedAnswer {
  const table = composeCustomGroups(info, plan, result);
  if (result.moduleGone || result.total === 0 || !result.groups.some((g) => g.count > 0)) return table;
  const field = plan.group ? customFieldFor(info, plan.group.by) : undefined;
  const isBool = field?.kind === 'boolean';
  const fieldWords = (field?.label ?? 'value').toLowerCase();
  const merged = new Map<string, number>();
  let noneGroups = 0;
  for (const g of result.groups.slice(0, MAX_CHART_POINTS)) {
    const key = g.key === null || g.key === '' ? NONE : g.key;
    if (key === NONE) noneGroups += 1;
    merged.set(key, (merged.get(key) ?? 0) + g.count);
  }
  const labelOf = (key: string): string => (key === NONE ? 'Not set'
    : isBool && (key === 'true' || key === 'false') ? (key === 'true' ? 'Yes' : 'No')
      : safeLabel(key, field?.label ?? 'Value'));
  const entries = [...merged].map(([key, count]) => ({ key, count, label: labelOf(key) }));
  // Most first, ties by label, "Not set" last.
  const ordered = [
    ...entries.filter((e) => e.key !== NONE).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    ...entries.filter((e) => e.key === NONE),
  ];
  if (ordered.length < 2) return tooFew(table, plan, ordered.length);
  const xs = pointKeys(ordered.map((e) => e.key));
  const items: Item[] = ordered.map((e, i) => ({
    x: xs[i], label: e.label, y: e.count,
    cell: e.key === NONE ? { t: 'text', v: 'Not set' }
      : isBool && (e.key === 'true' || e.key === 'false') ? { t: 'bool', v: e.key === 'true' }
        : { t: 'text', v: clip(scrubIds(e.key), 300) || null },
  }));
  const totalGroups = Math.max(result.totalGroups - Math.max(0, noneGroups - 1), items.length);
  const cut = totalGroups > items.length ? `Showing the ${items.length} biggest groups of ${totalGroups}.` : null;
  const state = chartState(cut, undefined);
  const { kind, changed } = kindFor(plan, items.length, 'categories');
  const title = clip(`${info.name} by ${fieldWords}`, 200);
  const points: ChartPoint[] = items.map((item) => ({ x: item.x, label: item.label, y: item.y }));
  const source = customSourceRef(info);
  const base = table.blocks[0] as DataTableBlock;
  const chart: ChartBlock = {
    id: 'b1',
    type: 'chart',
    title,
    kind,
    state,
    x: { label: clip(field?.label ?? 'Value', 120), kind: 'category' },
    y: { kind: 'count', label: clip(info.name, 120) },
    series: [{ key: clip(info.key, 80), label: clip(info.name, 120), source, points }],
    basis: clip(scrubIds(`Counts ${info.name} by ${fieldWords}. Every record is counted.`), 500),
    summary: clip(scrubIds(`${categoriesSummary(kind, title, points, info.name.toLowerCase(), !!cut)}${cut ? ` ${cut}` : ''}`), 500),
    table: chartTable({ ...base, id: 'b1-t', title, state }, items, [], state, totalGroups, !!cut),
  };
  return {
    blocks: withNotes([chart], changed ? [{ code: 'chart_kind_changed', text: changed }] : [], source, []),
    summary: `Showed a ${KIND_WORDS[kind]} chart of ${info.name} in ${items.length} groups.`,
    interpretedAs: table.interpretedAs,
    plan,
    dataRead: true,
  };
}
