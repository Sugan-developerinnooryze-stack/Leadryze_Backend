import mongoose from 'mongoose';
import { Activity, IActivity } from '../activities/activity.model';
import { CRMRecord } from '../crm/crm-record.model';

/* ── Intent parser ──────────────────────────────────────────────────────────── */

const TYPE_MAP: Record<string, string | null> = {
  task: 'task', tasks: 'task',
  event: 'event', events: 'event',
  booking: 'booking', bookings: 'booking',
  appointment: 'appointment', appointments: 'appointment',
  schedule: 'schedule', schedules: 'schedule',
  followup: 'followup', 'follow-up': 'followup', 'follow-ups': 'followup', 'followups': 'followup',
  meeting: 'booking', meetings: 'booking',
  activity: null, activities: null,
};

const STATUS_MAP: Record<string, string> = {
  pending: 'pending', open: 'pending', todo: 'pending',
  'in progress': 'in_progress', ongoing: 'in_progress', active: 'in_progress',
  completed: 'completed', done: 'completed', finished: 'completed', closed: 'completed',
  cancelled: 'cancelled', canceled: 'cancelled',
};

function extractType(msg: string): string | null | undefined {
  const lower = msg.toLowerCase();
  for (const [kw, val] of Object.entries(TYPE_MAP)) {
    if (lower.includes(kw)) return val; // null = all types, undefined = not found
  }
  return undefined;
}

function extractStatus(msg: string): string | undefined {
  const lower = msg.toLowerCase();
  for (const [kw, val] of Object.entries(STATUS_MAP)) {
    if (lower.includes(kw)) return val;
  }
}

function extractPerson(msg: string): string | undefined {
  const patterns = [
    /(?:does|do)\s+([a-z0-9_\- ]+?)\s+have/i,
    /([a-z0-9_\- ]+?)(?:'s|s')\s+(?:task|event|booking|activity|activities|follow|schedule|appointment|meeting)/i,
    /(?:task|event|booking|activities|follow.?up|schedule|appointment|meeting)s?\s+(?:for|of|by)\s+([a-z0-9_\- ]+)/i,
    /(?:show|list|find|get)\s+(?:all\s+)?(?:task|event|activity|activities)s?\s+(?:for|of|by)\s+([a-z0-9_\- ]+)/i,
    /(?:what|any)\s+(?:task|event|activity|activities)s?\s+(?:does|for)?\s*([a-z0-9_\- ]+)/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m?.[1]) return m[1].trim();
  }
}

function extractPriority(msg: string): string | undefined {
  if (/high.?priority|urgent/i.test(msg)) return 'high';
  if (/medium.?priority/i.test(msg)) return 'medium';
  if (/low.?priority/i.test(msg)) return 'low';
}

function isStatsQuery(msg: string) {
  return /how many|count|total|summary|overview|stats/i.test(msg);
}

function isOverdueQuery(msg: string) {
  return /overdue|past due|missed|late/i.test(msg);
}

function isUpcomingQuery(msg: string) {
  return /upcoming|next|today|tomorrow|this week|schedule/i.test(msg);
}

/* ── Formatter ──────────────────────────────────────────────────────────────── */

function fmtDate(d?: Date | null): string {
  if (!d) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtActivity(a: IActivity, idx: number): string {
  const type = a.customType || a.type;
  const status = a.status.replace('_', ' ');
  const priority = a.priority ? ` · ${a.priority} priority` : '';
  const date = fmtDate(a.dueDate || a.startDate);
  const dateStr = date ? ` · ${date}` : '';
  const person = a.linkedPerson?.displayName ? ` (${a.linkedPerson.displayName})` : '';
  const notes = a.notes ? `\n   _${a.notes.slice(0, 80)}${a.notes.length > 80 ? '…' : ''}_` : '';
  return `${idx}. **${a.title}**${person}\n   ${type} · ${status}${priority}${dateStr}${notes}`;
}

/* ── Main handler ───────────────────────────────────────────────────────────── */

export interface CrmChatResponse {
  response: string;
  escalate: boolean;
  capturedData: Record<string, unknown>;
}

export async function handleCrmChat(
  tenantId: string,
  message: string,
): Promise<CrmChatResponse> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const msg = message.trim();

  const typeVal = extractType(msg);
  const status  = extractStatus(msg);
  const person  = extractPerson(msg);
  const priority = extractPriority(msg);
  const overdue  = isOverdueQuery(msg);
  const upcoming = isUpcomingQuery(msg);
  const stats    = isStatsQuery(msg);

  // ── Build MongoDB filter ──────────────────────────────────────────────────
  const filter: Record<string, unknown> = { tenantId: tid };
  if (typeVal !== undefined && typeVal !== null) filter.type = typeVal;
  if (status) filter.status = status;
  if (priority) filter.priority = priority;

  if (person) {
    filter['linkedPerson.displayName'] = { $regex: person, $options: 'i' };
  }

  const now = new Date();
  if (overdue) {
    const dateFilter = { $lt: now, $ne: null };
    filter.$or = [{ dueDate: dateFilter }, { startDate: dateFilter }];
    if (!status) filter.status = { $in: ['pending', 'in_progress'] };
  } else if (upcoming) {
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    filter.$or = [
      { dueDate: { $gte: now, $lte: end } },
      { startDate: { $gte: now, $lte: end } },
    ];
  }

  // ── Stats query ───────────────────────────────────────────────────────────
  if (stats && !person) {
    const [total, pending, inProgress, completed] = await Promise.all([
      Activity.countDocuments({ tenantId: tid }),
      Activity.countDocuments({ tenantId: tid, status: 'pending' }),
      Activity.countDocuments({ tenantId: tid, status: 'in_progress' }),
      Activity.countDocuments({ tenantId: tid, status: 'completed' }),
    ]);
    const typeBreakdown = await Activity.aggregate([
      { $match: { tenantId: tid } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);
    const byType = typeBreakdown.map((t: { _id: string; count: number }) => `${t._id}: ${t.count}`).join(', ');
    return {
      response: `**Activity Summary**\n\nTotal: **${total}** activities\n• Pending: ${pending}\n• In Progress: ${inProgress}\n• Completed: ${completed}\n\n**By type:** ${byType || 'none'}`,
      escalate: false,
      capturedData: { total, pending, inProgress, completed },
    };
  }

  // ── Activity search ───────────────────────────────────────────────────────
  const activities = await Activity.find(filter)
    .sort({ dueDate: 1, startDate: 1, createdAt: -1 })
    .limit(10)
    .lean();

  if (activities.length > 0) {
    const personLabel = person ? ` for **${person}**` : '';
    const typeLabel   = typeVal ? ` ${typeVal}s` : ' activities';
    const statusLabel = status  ? ` (${status.replace('_', ' ')})` : '';
    const header      = `Found **${activities.length}**${typeLabel}${personLabel}${statusLabel}:\n\n`;
    const lines = activities.map((a, i) => fmtActivity(a as unknown as IActivity, i + 1)).join('\n\n');
    return {
      response: header + lines,
      escalate: false,
      capturedData: { count: activities.length, type: typeVal || 'all', person: person || null },
    };
  }

  // ── CRM record fallback: search by person name in CRM records ─────────────
  if (person) {
    const crmResults = await CRMRecord.find({
      tenantId: tid,
      displayName: { $regex: person, $options: 'i' },
    }).limit(5).lean();

    if (crmResults.length > 0) {
      const lines = crmResults.map((r, i) =>
        `${i + 1}. **${r.displayName}** · ${r.module} (${r.channel})`
      ).join('\n');
      return {
        response: `No activities found for **${person}**. Found them in your CRM records though:\n\n${lines}\n\nYou can add activities for them from the **Management** page.`,
        escalate: false,
        capturedData: { person, crmFound: true },
      };
    }

    return {
      response: `I couldn't find any activities or CRM records for **"${person}"**. Try checking the spelling or search from the Management page.`,
      escalate: false,
      capturedData: { person, found: false },
    };
  }

  // ── No results ────────────────────────────────────────────────────────────
  const suggestions = [
    '• "Does [name] have any tasks?"',
    '• "Show all pending tasks"',
    '• "Upcoming appointments"',
    '• "Overdue follow-ups"',
    '• "How many activities total?"',
  ].join('\n');

  return {
    response: `No activities found matching your query. Try:\n\n${suggestions}`,
    escalate: false,
    capturedData: {},
  };
}
