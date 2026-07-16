import mongoose from 'mongoose';
import { CalendarEvent } from './calendar-event.model';
import { CRMRecord } from '../crm/crm-record.model';
import { Connector } from '../connectors/connector.model';
import { Activity } from '../activities/activity.model';

/* ── Connector → calendar event color ─────────────────────────────────────── */
const CHANNEL_COLORS: Record<string, string> = {
  zoho:        '#ef4444',
  hubspot:     '#f97316',
  salesforce:  '#3b82f6',
  mysql:       '#10b981',
  postgresql:  '#8b5cf6',
  mongodb:     '#22c55e',
};

/* ── Known date fields per connector ──────────────────────────────────────── */
const CRM_DATE_FIELDS: Record<string, string[]> = {
  zoho: [
    'Start_DateTime', 'From', 'From_Date', 'End_DateTime', 'To', 'To_Date',
    'Due_Date', 'Closing_Date', 'Call_Start_Time', 'Created_Time', 'Activity_Date',
  ],
  hubspot: [
    'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_timestamp',
    'closedate', 'hs_activity_date', 'createdate', 'start_time',
  ],
  salesforce: [
    'StartDateTime', 'EndDateTime', 'ActivityDate', 'CloseDate',
    'CreatedDate', 'ReminderDateTime',
  ],
};

function toDate(val: unknown): Date | null {
  if (!val) return null;
  const d = new Date(String(val));
  return isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
}

function extractEventDates(
  channel: string,
  data: Record<string, unknown>
): { start: Date; end?: Date } | null {
  const knownStart = CRM_DATE_FIELDS[channel] || [];
  let start: Date | null = null;
  let end: Date | null = null;

  // Try known primary start fields first
  for (const field of knownStart) {
    const d = toDate(data[field]);
    if (d) { start = d; break; }
  }

  // Try known end fields
  const END_FIELDS: Record<string, string[]> = {
    zoho:       ['End_DateTime', 'To', 'To_Date'],
    hubspot:    ['hs_meeting_end_time'],
    salesforce: ['EndDateTime'],
  };
  for (const field of END_FIELDS[channel] || []) {
    const d = toDate(data[field]);
    if (d) { end = d; break; }
  }

  // Fallback: scan all string values whose key name suggests a date
  if (!start) {
    const DATE_KEY_RE = /date|time|_at|start|due|close|from|begin/i;
    for (const [key, val] of Object.entries(data)) {
      if (!DATE_KEY_RE.test(key)) continue;
      const d = toDate(val);
      if (d) { start = d; break; }
    }
  }

  if (!start) return null;
  return end ? { start, end } : { start };
}

/* ── Unified calendar event shape (FullCalendar-compatible) ───────────────── */
export interface CalendarEventDTO {
  id:       string;
  title:    string;
  start:    string;
  end?:     string;
  allDay?:  boolean;
  color:    string;
  extendedProps: {
    sourceType:   'crm' | 'manual' | 'activity';
    channel?:     string;
    module?:      string;
    externalId?:  string;
    displayName?: string;
    data?:        Record<string, unknown>;
    linkedRecord?: {
      channel: string; module: string; externalId: string; displayName: string;
    };
    description?: string;
    location?:    string;
    createdBy?:   string;
  };
}

/* ── Main service ─────────────────────────────────────────────────────────── */
export async function getCalendarEvents(
  tenantId: string,
  start: Date,
  end: Date
): Promise<CalendarEventDTO[]> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const events: CalendarEventDTO[] = [];

  // 1. Manual bookings from calendarevents collection
  const manualEvents = await CalendarEvent.find({
    tenantId: tid,
    startDate: { $lte: end },
    $or: [{ endDate: { $gte: start } }, { endDate: null, startDate: { $gte: start } }],
  }).lean();

  for (const e of manualEvents) {
    events.push({
      id:    `evt_${e._id}`,
      title: e.title,
      start: e.startDate.toISOString(),
      end:   e.endDate?.toISOString(),
      allDay: e.allDay,
      color: e.color || '#6366f1',
      extendedProps: {
        sourceType:   'manual',
        description:  e.description,
        location:     e.location,
        createdBy:    e.createdBy,
        linkedRecord: e.linkedRecord as CalendarEventDTO['extendedProps']['linkedRecord'],
      },
    });
  }

  // 2. CRM synced records — only from connectors that are currently active
  const activeConnectors = await Connector.find({ tenantId: tid, isActive: true }).select('type').lean();
  const activeChannels = activeConnectors.map((c) => c.type);

  if (activeChannels.length === 0) return events;

  const crmRecords = await CRMRecord.find({ tenantId: tid, channel: { $in: activeChannels } })
    .limit(5000)
    .lean();

  for (const rec of crmRecords) {
    const dates = extractEventDates(rec.channel, rec.data as Record<string, unknown>);
    if (!dates) continue;

    // Check if the event's start falls within the requested range
    if (dates.start < start || dates.start > end) continue;

    const color = CHANNEL_COLORS[rec.channel] || '#64748b';
    events.push({
      id:    `crm_${rec.externalId || rec._id}`,
      title: rec.displayName || rec.module,
      start: dates.start.toISOString(),
      end:   dates.end?.toISOString(),
      color,
      extendedProps: {
        sourceType:  'crm',
        channel:     rec.channel,
        module:      rec.module,
        externalId:  rec.externalId,
        displayName: rec.displayName,
        data:        rec.data as Record<string, unknown>,
      },
    });
  }

  // 3. crmactivities — activities that have a startDate in range
  const activities = await Activity.find({
    tenantId: tid,
    startDate: { $gte: start, $lte: end },
  }).lean();

  for (const act of activities) {
    const typeColors: Record<string, string> = {
      task:        '#6366f1',
      event:       '#3b82f6',
      booking:     '#10b981',
      appointment: '#f97316',
      schedule:    '#8b5cf6',
      followup:    '#ef4444',
      custom:      '#64748b',
    };
    events.push({
      id:    `act_${act._id}`,
      title: act.title,
      start: act.startDate!.toISOString(),
      end:   act.endDate?.toISOString(),
      allDay: act.allDay,
      color: act.color || typeColors[act.type] || '#6366f1',
      extendedProps: {
        sourceType:  'activity',
        module:      act.customType || act.type,
        description: act.notes,
        location:    act.location,
        displayName: act.linkedPerson?.displayName,
        data: {
          type:    act.type,
          status:  act.status,
          priority: act.priority,
          person:  act.linkedPerson?.displayName,
          channel: act.linkedPerson?.channel,
          ...act.fields as Record<string, unknown>,
        },
      },
    });
  }

  return events;
}
