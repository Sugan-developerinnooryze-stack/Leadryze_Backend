import type {
  AgendaBlock, Cell, ClarifyBlock, DataTableBlock, FilterChip, FormBlock, KpiGroupBlock, KpiItem, PipelineBlock, RecordDetailBlock,
  SectionState, ViewBlock,
} from '../contracts/views';
import { getModuleCap } from '../registry';
import { dayText } from './chips';
import { localDateKey, localTime } from '../../daily-events/daily-events.time';
import { isValidTimeZone } from '../../native-crm/shared/date-range';

/* The deterministic `response` text of an engine answer, built from the
 * same (already validated) blocks the chat draws: a short heading, a
 * markdown pipe table for lists with "Showing N of TOTAL", "You can see 9
 * Field Service customers." for counts, the notice texts, and a clarify's
 * question with its choices as a numbered list. Clients that
 * can't draw blocks show this; clients that can show it as a caption.
 * Record ids (24-hex) never appear. Increment 6: a guided form says what it
 * still needs (Increment 7: its lines too), a review says to confirm or
 * cancel, a result its message. Increment 8: a chart says what it shows and
 * its basis, then its numbers as a table; a pipeline its stages in order with
 * their counts and amounts (never added across currencies); an agenda each
 * module's totals per part of the window, then the items it lists. */

export const DEFAULT_SOURCE = 'LeadRyze CRM';
const SOURCE_ORDER = ['Native CRM', 'Field Service', 'Custom Modules', 'Custom Fields'];

/** Removes anything shaped like a record id from text meant to be read: a
 * run of 24 or more hex digits, also when joined to a word by "_" or to
 * another id ("record_5f8d…", two ids run together). */
export function scrubIds(text: string): string {
  return text.replace(/(?<![a-f0-9])[a-f0-9]{24,}(?![a-f0-9])/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function singularOf(module: string, plural: string): string {
  return getModuleCap(module)?.labels.singular ?? plural;
}

export function cellText(cell: Cell): string {
  switch (cell.t) {
    case 'text': return cell.v ?? '—';
    case 'number':
      if (cell.v === null) return '—';
      return cell.unit === 'percent' ? `${cell.v}%` : cell.unit ? `${cell.v} ${cell.unit}` : String(cell.v);
    case 'money':
      if (cell.v === null) return '—';
      return cell.currency ? `${cell.currency} ${cell.v.toLocaleString('en-IN')}` : cell.v.toLocaleString('en-IN');
    case 'date': return cell.v ?? '—';
    case 'datetime': {
      const d = cell.v ? new Date(cell.v) : null;
      if (!d || Number.isNaN(d.getTime())) return cell.v ?? '—';
      const tz = isValidTimeZone(cell.tz) ? cell.tz : 'UTC';
      return `${localDateKey(d, tz)} ${localTime(d, tz)}`;
    }
    case 'status': return cell.label;
    case 'bool': return cell.v === null ? '—' : cell.v ? 'Yes' : 'No';
    case 'ref': return cell.label;
    case 'masked': return cell.display;
    default: return '—';
  }
}

function tableCell(cell: Cell | undefined): string {
  const text = scrubIds(cell ? cellText(cell) : '—').replace(/[\r\n]+/g, ' ');
  const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return short.replace(/\|/g, '\\|') || '—';
}

/** A table's title inside a sentence: lower case, except words in capitals
 * ("Purchase amount by customer in INR" is "purchase amount by customer in INR"). */
function titleWords(title: string): string {
  return title.split(' ').map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase())).join(' ');
}

/** The filters a block ran with, in the chips' own words: " (Overdue, Due: this week)". */
function filtersText(filters: readonly FilterChip[]): string {
  return filters.length ? ` (${filters.map((f) => f.label.replace(/[\r\n]+/g, ' ')).join(', ')})` : '';
}

/** A data table, or a chart's numbers as one (Increment 8: the chart table has no handle). */
function tableText(block: Pick<DataTableBlock, 'source' | 'title' | 'rows' | 'page' | 'filters' | 'columns' | 'state'>): string {
  const heading = `${block.source.label} ${titleWords(block.title)}`;
  if (block.rows.length === 0) return block.state.message ?? `No ${heading} to show.`;
  const total = block.page.total ?? block.rows.length;
  const lines = [
    `${heading}${filtersText(block.filters)}`,
    `Showing ${block.rows.length} of ${total}${block.page.total === null ? '+' : ''}.`,
    '',
    `| ${block.columns.map((c) => c.label.replace(/\|/g, '\\|')).join(' | ')} |`,
    `| ${block.columns.map(() => '---').join(' | ')} |`,
    ...block.rows.map((row) => `| ${block.columns.map((c) => tableCell(row.cells[c.key])).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** True when the section's numbers were actually read (a 0 is data). */
export function hasData(state: SectionState): boolean {
  return state.status === 'ok' || state.status === 'partial' || state.status === 'empty';
}

function isConnectorItem(item: KpiItem): boolean {
  return item.source.key.startsWith('connector:');
}

/** Sync health travels next to a connector number, never instead of it. */
function freshnessNote(item: KpiItem): string {
  const status = item.source.freshness?.syncStatus;
  if (status === 'failed') return ' (as of the last successful sync)';
  if (status === 'syncing') return ' (a sync is running)';
  return '';
}

function unavailableText(item: KpiItem): string {
  return item.state.message ?? `Couldn't read ${item.source.moduleLabel} right now.`;
}

function kpiValueText(item: KpiItem): string | null {
  if (!item.value || item.value.v === null || !hasData(item.state)) return null;
  if (item.value.t === 'money') return cellText(item.value);
  return `${item.value.v}${item.state.lowerBound ? '+' : ''}`;
}

/** A per-source group ("Customers by source"): its tiles are named by their
 * own labels ("Contacts marked as customers"), never by the module's. */
function isPerSourceGroup(block: KpiGroupBlock): boolean {
  return /\bby source$/i.test(block.title ?? '');
}

/** A tile's hint as written after its number: " (From 2 receipts; Payment date: this month)". */
function hintText(item: KpiItem): string {
  return item.hint ? ` (${item.hint.replace(/[\r\n]+/g, ' ')})` : '';
}

/** A named total's tile ("Payments received"): whose records it adds up when the
 * scope is narrower than everything ("from receipts you can see"), as a count
 * says "You can see". */
function moneyLabel(item: KpiItem): string {
  return item.source.scope === 'all' ? item.label : `${item.label} from ${item.source.moduleLabel.toLowerCase()} you can see`;
}

/** The message of a partial tile ("Only invoices visible to you were checked."), after its line. */
function partialNote(item: KpiItem): string {
  return item.state.status === 'partial' && item.state.message ? ` ${item.state.message.replace(/[\r\n]+/g, ' ')}` : '';
}

function kpiText(block: KpiGroupBlock): string {
  // Several tiles (one per source or currency): a line each, never a total. A
  // named total's tiles keep their conditions and scope, as a single one does.
  if (block.items.length > 1 || isPerSourceGroup(block)) {
    const lines = block.items.map((item) => {
      const value = kpiValueText(item);
      if (value !== null && item.value?.t === 'money') return `- ${moneyLabel(item)}: ${value}${hintText(item)}${partialNote(item)}`;
      return `- ${item.label}: ${value === null ? unavailableText(item) : `${value}${freshnessNote(item)}`}`;
    });
    return [block.title ?? '', ...lines].filter(Boolean).join('\n');
  }
  return block.items.map((item) => {
    if (!item.value || item.value.v === null) return unavailableText(item);
    const n = item.value.v;
    // A named total says what it added up: its conditions ("Payment date: this month"), whose records, a partial note.
    if (item.value.t === 'money') return `${moneyLabel(item)}: ${cellText(item.value)}${hintText(item)}.${partialNote(item)}`;
    if (isConnectorItem(item)) return `${item.label}: ${kpiValueText(item) ?? n}${freshnessNote(item)}.`;
    // A count with filters says which ("Overdue; Due: this week").
    const hint = hintText(item);
    // A Custom Module's singular name isn't in the block: its own label, never a wrong plural ("1 Site Visits").
    if (item.source.key === 'custom_module') return `${item.label} (${item.source.label}): ${n}${hint}.`;
    const noun = (n === 1 ? singularOf(item.source.module, item.source.moduleLabel) : item.source.moduleLabel).toLowerCase();
    return `You can see ${n} ${item.source.label} ${noun}${hint}.`;
  }).join('\n');
}

/** At most this many of a record card's lines are written out. */
const MAX_TEXT_LINES = 10;

function detailText(block: RecordDetailBlock): string {
  const singular = singularOf(block.source.module, block.source.moduleLabel).toLowerCase();
  const number = block.record.entity.number ? ` ${block.record.entity.number}` : '';
  const lines = [`${block.source.label} ${singular}${number}: ${block.record.title}`];
  if (block.record.status) lines.push(`Status: ${block.record.status.label}`);
  for (const section of block.sections) {
    for (const field of section.fields) {
      if (field.value.t === 'status' && block.record.status) continue;
      const text = cellText(field.value);
      if (text !== '—') lines.push(`- ${field.label}: ${text}`);
    }
  }
  // Read-only lines, stored totals and related counts (Increment 5), as the card shows them.
  const rows = block.lines?.rows ?? [];
  if (rows.length) {
    lines.push('Lines:');
    for (const row of rows.slice(0, MAX_TEXT_LINES)) {
      const parts = (block.lines?.columns ?? []).map((c) => (row.cells[c.key] ? cellText(row.cells[c.key]) : '—')).filter((t) => t !== '—');
      lines.push(`- ${parts.join(' · ') || '—'}`);
    }
    if (rows.length > MAX_TEXT_LINES) lines.push(`- and ${rows.length - MAX_TEXT_LINES} more`);
  }
  for (const total of block.totals ?? []) lines.push(`${total.label}: ${cellText(total.value)}`);
  for (const related of block.related) {
    const counted = related.count !== null && hasData(related.state);
    const note = related.state.message ? ` (${related.state.message})` : '';
    lines.push(`${related.label}: ${counted ? `${related.count}${related.state.lowerBound ? '+' : ''}${note}` : related.state.message ?? 'not available'}`);
  }
  if (block.state.status === 'partial' && block.state.message) lines.push(block.state.message);
  return lines.join('\n');
}

/** A question back: the question, then one numbered line per choice. */
function clarifyText(block: ClarifyBlock): string {
  return [block.question, ...block.options.map((option, i) => `${i + 1}. ${option.label}`)].join('\n');
}

/** A guided form: its title, then the fields still missing or in error (in
 * the form's order, then a document's "Lines" when a line is in error or a
 * required line is still missing), or the step left when there are none. */
function formText(block: FormBlock): string {
  const needed = block.fields.filter((f) => block.errors[f.key]).map((f) => f.label);
  const lineError = Object.keys(block.errors).some((key) => key === 'lines' || key.startsWith('lines.'));
  if (lineError || (block.lines?.required && !block.lines.rows.length)) needed.push('Lines');
  return needed.length ? `${block.title}. Still needed: ${needed.join(', ')}.` : `${block.title}. Check the values, then press Review.`;
}

/** One row of a markdown pipe table; a cell's own pipes and line breaks are escaped. */
function pipeRow(cells: readonly string[]): string {
  return `| ${cells.map((c) => c.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`;
}

/** A pipeline (Increment 8): how many records in how many stages, then a row
 * per stage in the pipeline's order with its count and its amount in each
 * currency (never added together), then the records in no listed stage. */
function pipelineText(block: PipelineBlock): string {
  const heading = `${block.source.label} ${titleWords(block.title)}`;
  const off = block.offPipeline;
  // Nothing counted: the block's own state says why (as an empty table does).
  if (!block.stages.some((s) => s.count > 0) && !off) return block.state.message ?? `No ${heading} to show.`;
  const total = block.stages.reduce((n, s) => n + s.count, 0) + (off?.count ?? 0);
  const noun = (total === 1 ? singularOf(block.source.module, block.source.moduleLabel) : block.source.moduleLabel).toLowerCase();
  const n = block.stages.length;
  const amountLabel = block.amountLabel;
  const columns = ['Stage', block.source.moduleLabel, ...(amountLabel ? [amountLabel] : [])];
  const lines = [
    `${heading}${filtersText(block.filters)}`,
    `${total} ${noun} in ${n} ${n === 1 ? 'stage' : 'stages'}.`,
    '',
    pipeRow(columns),
    pipeRow(columns.map(() => '---')),
    ...block.stages.map((s) => pipeRow([
      s.label, String(s.count),
      ...(amountLabel ? [(s.amounts ?? []).map((a) => cellText({ t: 'money', v: a.v, currency: a.currency })).join('; ')] : []),
    ])),
  ];
  // After a blank line, so the note isn't read as one more row of the table.
  if (off) lines.push('', off.note);
  return lines.join('\n');
}

const AGENDA_BUCKET_WORDS: Readonly<Record<'overdue' | 'today' | 'upcoming', string>> = {
  overdue: 'overdue', today: 'today', upcoming: 'in the next 7 days',
};

/** An agenda (Increment 8): its window, then a line per module and part of
 * the window with its exact total ("Showing 5 of 12" when fewer are listed),
 * or why the module isn't counted; then the items listed, as a table. */
function agendaText(block: AgendaBlock): string {
  const lines = [`${block.title}: ${block.window.label}.`];
  const rows: string[] = [];
  for (const group of block.groups) {
    const name = `${group.source.label} ${group.source.moduleLabel}`;
    if (!hasData(group.state)) {
      const why = group.state.status === 'no_permission' ? 'no access.' : group.state.status === 'disabled' ? 'turned off.' : "couldn't be read.";
      lines.push(`${name}: ${group.state.message ?? why}`);
      continue;
    }
    for (const bucket of group.buckets) {
      const words = bucket.bucket === 'window' ? bucket.label?.toLowerCase() ?? 'in this period' : AGENDA_BUCKET_WORDS[bucket.bucket];
      // A part that couldn't be read is never a 0.
      if (bucket.total === null) {
        lines.push(`${name}: ${words} couldn't be read.`);
      } else {
        const total = `${bucket.total}${bucket.lowerBound ? '+' : ''}`;
        const showing = bucket.items.length < bucket.total ? ` Showing ${bucket.items.length} of ${total}.` : '';
        lines.push(`${name}: ${total} ${words}.${showing}`);
      }
      for (const item of bucket.items) {
        const when = `${bucket.bucket === 'today' ? 'Today' : dayText(item.date)}${item.time ? ` ${item.time}` : ''}`;
        rows.push(pipeRow([when, item.title, group.source.moduleLabel, item.status?.label ?? '']));
      }
    }
  }
  if (rows.length) lines.push('', pipeRow(['When', 'What', 'Module', 'Status']), pipeRow(['---', '---', '---', '---']), ...rows);
  return lines.join('\n');
}

function blockText(block: ViewBlock): string {
  switch (block.type) {
    case 'source_group':
      return block.sections.map((s) => (s.blocks.length
        ? s.blocks.map(blockText).filter(Boolean).join('\n\n')
        : s.state.message ?? '')).filter(Boolean).join('\n\n');
    case 'data_table': return tableText(block);
    case 'kpi_group': return kpiText(block);
    case 'record_detail': return detailText(block);
    case 'notice': return block.text;
    case 'clarify': return clarifyText(block);
    case 'form': return formText(block);
    case 'review': return `Review: ${block.title}. Confirm or cancel below.`;
    case 'result': return block.message;
    // What the chart shows and its basis, then its numbers (its text alternative).
    case 'chart': return [block.summary, block.basis, '', tableText(block.table)].join('\n');
    case 'pipeline': return pipelineText(block);
    case 'agenda': return agendaText(block);
    default: return '';
  }
}

export function fallbackText(blocks: ViewBlock[]): string {
  const text = blocks.map(blockText).filter(Boolean).join('\n\n');
  return scrubIds(text.replace(/\n{3,}/g, '\n\n')) || 'Done.';
}

/** The badge: the SourceRef labels of the data shown, in the usual order,
 * joined like the existing assistant's badge. */
export function sourceBadge(blocks: ViewBlock[]): string {
  const labels: string[] = [];
  const add = (label?: string) => { if (label && !labels.includes(label)) labels.push(label); };
  const visit = (block: ViewBlock) => {
    switch (block.type) {
      case 'source_group': block.sections.forEach((s) => { add(s.source.label); s.blocks.forEach(visit); }); break;
      case 'data_table': add(block.source.label); break;
      // A tile names its source only when its number was read: a source that
      // is not connected, switched off or refused is never in the badge.
      case 'kpi_group': block.items.forEach((i) => { if (hasData(i.state)) add(i.source.label); }); break;
      case 'record_detail': add(block.source.label); break;
      // A guided form or a review shows the record's source (its values or the changes).
      case 'form': case 'review': add(block.source.label); break;
      case 'notice': add(block.source?.label); break;
      // A question back reads no data: its choices name no source in the badge.
      case 'clarify': break;
      // Increment 8: a chart names each series' source, a pipeline its own and an
      // agenda each module's, only when that number was read (like a tile).
      case 'chart': if (hasData(block.state)) block.series.forEach((s) => add(s.source.label)); break;
      case 'pipeline': if (hasData(block.state)) add(block.source.label); break;
      case 'agenda': block.groups.forEach((g) => { if (hasData(g.state)) add(g.source.label); }); break;
      default: break;
    }
  };
  blocks.forEach(visit);
  if (!labels.length) return DEFAULT_SOURCE;
  labels.sort((a, b) => (SOURCE_ORDER.indexOf(a) + 1 || 99) - (SOURCE_ORDER.indexOf(b) + 1 || 99));
  return labels.join(' + ');
}
