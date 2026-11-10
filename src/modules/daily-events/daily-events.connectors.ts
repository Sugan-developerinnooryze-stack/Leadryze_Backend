import { DailyEvent, DailyEventBucket, DailyEventCategory, DailyEventStatus } from './daily-events.types';
import { DayWindows, bucketForKey, localDateKey, localTime } from './daily-events.time';

/** Connector records (CRMRecord.data) are raw strings copied from the
 * vendor, with no Date type and no index, so dates are parsed here from the
 * vendor's own field names. Zoho's names are confirmed against synced data;
 * Salesforce and HubSpot use their documented API field names — a field the
 * sync did not store simply yields no event, never a guessed date. */
export interface ConnectorModuleDef {
  /** CRMRecord.module as stored by the sync. */
  module: string;
  label: string;
  category: DailyEventCategory;
  date: string[];
  end?: string[];
  /** A vendor flag ('true'/'false') marking an all-day item, and the
   * date-only field that then holds its day (Salesforce Events). */
  allDay?: { flag: string; date: string[] };
  title: string[];
  status?: string[];
  related?: string[];
  owner?: string[];
  /** Whether a record is finished. Without it the module has no overdue
   * section. Anything not positively known to be open is never overdue. */
  closure?: {
    /** Vendor booleans ('true'/'false'), used first when synced. */
    flags?: string[];
    /** Lower-case status values known to be open / finished. */
    open?: string[];
    closed?: string[] | ((status: string) => boolean);
  };
}

export const CONNECTOR_EVENT_MODULES: Record<string, ConnectorModuleDef[]> = {
  zoho: [
    { module: 'Meetings', label: 'Meetings', category: 'meeting', date: ['From', 'Start_DateTime'], end: ['To', 'End_DateTime'], title: ['Event_Title', 'Subject'], status: ['Checked_In_Status'], related: ['Related_To', 'Contact_Name'], owner: ['Host', 'Owner'] },
    { module: 'Calls', label: 'Calls', category: 'call', date: ['Call_Start_Time'], title: ['Subject'], status: ['Call_Status', 'Outgoing_Call_Status'], related: ['Related_To', 'Contact_Name'], owner: ['Call_Owner'] },
    {
      module: 'Tasks', label: 'Tasks', category: 'task', date: ['Due_Date'], title: ['Subject'], status: ['Status'], related: ['Related_To', 'Contact_Name'], owner: ['Task_Owner'],
      closure: { open: ['not started', 'deferred', 'in progress', 'waiting for input'], closed: ['completed'] },
    },
    {
      module: 'Deals', label: 'Deals', category: 'deal', date: ['Closing_Date'], title: ['Deal_Name'], status: ['Stage'], related: ['Account_Name', 'Contact_Name'], owner: ['Deal_Owner'],
      closure: {
        open: ['qualification', 'needs analysis', 'value proposition', 'id. decision makers', 'perception analysis', 'proposal/price quote', 'negotiation/review'],
        closed: (s) => s.startsWith('closed'),
      },
    },
    {
      module: 'Invoices', label: 'Invoices', category: 'invoice', date: ['Due_Date'], title: ['Subject'], status: ['Status'], related: ['Account_Name'], owner: ['Invoice_Owner'],
      closure: { open: ['created', 'approved'], closed: ['paid', 'cancelled'] },
    },
  ],
  salesforce: [
    {
      module: 'Events', label: 'Events', category: 'meeting', date: ['StartDateTime', 'ActivityDateTime'], end: ['EndDateTime'], title: ['Subject'],
      allDay: { flag: 'IsAllDayEvent', date: ['ActivityDate'] },
    },
    {
      module: 'Tasks', label: 'Tasks', category: 'task', date: ['ActivityDate'], title: ['Subject'], status: ['Status'],
      closure: { flags: ['IsClosed'], open: ['not started', 'in progress', 'waiting on someone else', 'deferred'], closed: ['completed'] },
    },
    {
      module: 'Opportunities', label: 'Opportunities', category: 'deal', date: ['CloseDate'], title: ['Name'], status: ['StageName'],
      closure: {
        flags: ['IsClosed'],
        open: ['prospecting', 'qualification', 'needs analysis', 'value proposition', 'id. decision makers', 'perception analysis', 'proposal/price quote', 'negotiation/review'],
        closed: ['closed won', 'closed lost'],
      },
    },
  ],
  hubspot: [
    { module: 'Meetings', label: 'Meetings', category: 'meeting', date: ['hs_meeting_start_time', 'hs_timestamp'], end: ['hs_meeting_end_time'], title: ['hs_meeting_title'] },
    { module: 'Calls', label: 'Calls', category: 'call', date: ['hs_timestamp'], title: ['hs_call_title'], status: ['hs_call_status'] },
    {
      module: 'Tasks', label: 'Tasks', category: 'task', date: ['hs_timestamp'], title: ['hs_task_subject'], status: ['hs_task_status'],
      closure: { open: ['not_started', 'in_progress', 'waiting', 'deferred'], closed: ['completed'] },
    },
    {
      module: 'Deals', label: 'Deals', category: 'deal', date: ['closedate'], title: ['dealname'], status: ['dealstage'],
      // Only the default pipeline's stage ids are known; other pipelines use
      // numeric ids, so without hs_is_closed their deals stay "unknown".
      closure: {
        flags: ['hs_is_closed'],
        open: ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent'],
        closed: ['closedwon', 'closedlost'],
      },
    },
  ],
};

export const CONNECTOR_LABELS: Record<string, string> = {
  zoho: 'Zoho CRM',
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
};

/** Records read per connector module (newest first). CRMRecord.data has no
 * date index, so the module is scanned; beyond this the module is marked
 * incomplete and its counts become "at least". */
export const CONNECTOR_SCAN_LIMIT: number = 20000;

/** The keys to project from CRMRecord.data for one module definition. */
export function connectorProjection(def: ConnectorModuleDef): Record<string, 1> {
  const keys = [
    ...def.date, ...(def.end ?? []), ...(def.allDay ? [def.allDay.flag, ...def.allDay.date] : []),
    ...def.title, ...(def.status ?? []), ...(def.related ?? []), ...(def.owner ?? []), ...(def.closure?.flags ?? []),
  ];
  const projection: Record<string, 1> = { displayName: 1, externalId: 1 };
  for (const key of keys) projection[`data.${key}`] = 1;
  return projection;
}

/** A vendor value as a non-empty string; vendors' "null" placeholders count as empty. */
export function vendorText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return undefined;
  const t = String(value).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return undefined;
  return t;
}

export type ParsedVendorDate = { kind: 'date'; key: string } | { kind: 'instant'; at: Date };

/** YYYY-MM-DD → a calendar date; epoch seconds/ms or ISO → an instant. */
export function parseVendorDate(value: unknown): ParsedVendorDate | null {
  const t = vendorText(value);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const probe = new Date(`${t}T00:00:00.000Z`);
    return Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== t ? null : { kind: 'date', key: t };
  }
  if (/^\d{10}$/.test(t)) return { kind: 'instant', at: new Date(Number(t) * 1000) };
  if (/^\d{13}$/.test(t)) return { kind: 'instant', at: new Date(Number(t)) };
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? null : { kind: 'instant', at };
}

function firstValue(data: Record<string, unknown> | undefined, keys: string[] | undefined): string | undefined {
  if (!data || !keys) return undefined;
  for (const key of keys) {
    const v = vendorText(data[key]);
    if (v) return v;
  }
  return undefined;
}

function firstDate(data: Record<string, unknown> | undefined, keys: string[]): ParsedVendorDate | null {
  if (!data) return null;
  for (const key of keys) {
    const parsed = parseVendorDate(data[key]);
    if (parsed) return parsed;
  }
  return null;
}

/** 'open' | 'closed' | 'unknown' for one record. */
export function connectorClosure(def: ConnectorModuleDef, data: Record<string, unknown> | undefined, statusKey: string | undefined): 'open' | 'closed' | 'unknown' {
  const closure = def.closure;
  if (!closure) return 'unknown';
  const flag = firstValue(data, closure.flags)?.toLowerCase();
  if (flag === 'true') return 'closed';
  if (flag === 'false') return 'open';
  if (!statusKey) return 'unknown';
  const closed = typeof closure.closed === 'function' ? closure.closed(statusKey) : (closure.closed ?? []).includes(statusKey);
  if (closed) return 'closed';
  if ((closure.open ?? []).includes(statusKey)) return 'open';
  return 'unknown';
}

/** The record's start: an all-day vendor item uses its date-only field. */
function startOf(def: ConnectorModuleDef, data: Record<string, unknown> | undefined): ParsedVendorDate | null {
  if (def.allDay && firstValue(data, [def.allDay.flag])?.toLowerCase() === 'true') {
    const day = firstDate(data, def.allDay.date);
    if (day) return day.kind === 'date' ? day : { kind: 'date', key: day.at.toISOString().slice(0, 10) };
  }
  return firstDate(data, def.date);
}

const BUCKET_ORDER: DailyEventBucket[] = ['today', 'overdue', 'upcoming'];

/** Section first; then oldest first (today / upcoming) or most recent first
 * (overdue) by calendar date and time; then id — a consistent order, so the
 * per-section cap keeps the right items. */
export function compareEvents(a: DailyEvent, b: DailyEvent): number {
  const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
  if (byBucket) return byBucket;
  if (a.bucket === 'overdue') {
    return b.date.localeCompare(a.date)
      || (b.time ?? '').localeCompare(a.time ?? '')
      || a.id.localeCompare(b.id);
  }
  return a.date.localeCompare(b.date)
    || Number(b.allDay) - Number(a.allDay)
    || (a.time ?? '').localeCompare(b.time ?? '')
    || a.id.localeCompare(b.id);
}

export interface ConnectorExtraction {
  counts: { today: number; overdue: number; upcoming: number };
  events: DailyEvent[];
  /** Records that carried a readable date at all. */
  dated: number;
}

/** Turns one connector module's synced records into Daily Events. Pure, so
 * the date handling is unit-tested without a database. Events come back
 * sorted (compareEvents) and NOT capped — the caller caps them per section. */
export function extractConnectorEvents(
  type: string,
  def: ConnectorModuleDef,
  records: Array<{ _id?: unknown; externalId?: string; displayName?: string; data?: Record<string, unknown> }>,
  windows: DayWindows,
): ConnectorExtraction {
  const counts = { today: 0, overdue: 0, upcoming: 0 };
  const events: DailyEvent[] = [];
  const source = `connector:${type}`;
  let dated = 0;

  for (const record of records) {
    const parsed = startOf(def, record.data);
    if (!parsed) continue;
    dated += 1;
    const key = parsed.kind === 'date' ? parsed.key : localDateKey(parsed.at, windows.timezone);
    const bucket: DailyEventBucket | null = bucketForKey(key, windows);
    if (!bucket) continue;

    const rawStatus = firstValue(record.data, def.status);
    const statusKey = rawStatus?.toLowerCase();
    const closure = connectorClosure(def, record.data, statusKey);
    // Overdue only for records positively known to be open; upcoming hides finished ones.
    if (bucket === 'overdue' && closure !== 'open') continue;
    if (bucket === 'upcoming' && closure === 'closed') continue;
    counts[bucket] += 1;

    let status: DailyEventStatus | undefined;
    if (rawStatus) {
      const cancelled = /cancel|lost/.test(statusKey!);
      status = {
        key: statusKey!,
        label: rawStatus,
        tone: bucket === 'overdue' ? 'alert' : cancelled ? 'cancelled' : closure === 'closed' ? 'done' : 'open',
      };
    }
    const time = parsed.kind === 'instant' ? localTime(parsed.at, windows.timezone) : undefined;
    const endParsed = parsed.kind === 'instant' && def.end ? firstDate(record.data, def.end) : null;
    // An end on another day would read like a same-day slot: left out.
    const endTime = endParsed?.kind === 'instant' && localDateKey(endParsed.at, windows.timezone) === key
      ? localTime(endParsed.at, windows.timezone)
      : undefined;
    const relatedLabel = firstValue(record.data, def.related);
    const id = vendorText(record.externalId) ?? String(record._id ?? '');

    events.push({
      id: `${source}:${def.module}:${id}`,
      source,
      module: def.module,
      moduleLabel: def.label,
      category: def.category,
      bucket,
      title: firstValue(record.data, def.title) ?? vendorText(record.displayName) ?? def.label,
      kind: bucket === 'overdue' ? 'Was due' : def.category === 'deal' ? 'Expected close' : parsed.kind === 'date' ? 'Due' : 'Starts',
      date: key,
      time,
      endTime: endTime && endTime !== time ? endTime : undefined,
      allDay: parsed.kind === 'date',
      at: parsed.kind === 'instant' ? parsed.at.toISOString() : `${key}T00:00:00.000Z`,
      status,
      related: relatedLabel ? { module: 'related', label: relatedLabel } : undefined,
      leadFollowUp: false,
      assignee: firstValue(record.data, def.owner),
      link: { path: `/crm/${type}/${encodeURIComponent(def.module)}`, exact: false },
    });
  }

  events.sort(compareEvents);
  return { counts, events, dated };
}
