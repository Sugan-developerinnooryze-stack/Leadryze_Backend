import mongoose from 'mongoose';
import { Task } from '../tasks/task.model';
import { Ticket } from '../tickets/ticket.model';
import { Call } from '../calls/call.model';
import { Meeting } from '../meetings/meeting.model';
import { EmailLog } from '../../notifications/email-log.model';
import { ActivityFeedItem, ActivityKind, RelatedModule } from './activity-feed.types';
import { PaginatedResult } from '../native-crm.types';

/**
 * Merges Task/Ticket/Call/Meeting into one chronological feed for a single
 * Field Service (or Native CRM) record. Runs 4 parallel queries rather than
 * one query per activity (no N+1) — activity volume per record is small
 * (dozens, not thousands), so an in-memory merge+paginate is fine; if that
 * assumption changes, switch to capped per-collection queries instead.
 */
export async function getActivityFeed(
  tenantId: string,
  relatedModule: RelatedModule,
  relatedId: string,
  opts: { page?: number; limit?: number } = {},
): Promise<PaginatedResult<ActivityFeedItem>> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter = { tenantId: tid, relatedModule, relatedId };

  const [tasks, tickets, calls, meetings, emails] = await Promise.all([
    Task.find(filter).lean(),
    Ticket.find(filter).lean(),
    Call.find(filter).lean(),
    Meeting.find(filter).lean(),
    EmailLog.find(filter).lean(),
  ]);

  // EmailLog documents carry their own `kind` field (on_create_confirmation |
  // reminder), which would otherwise collide with and silently overwrite the
  // ActivityKind discriminant below — rename it to `sendKind` on the way in.
  const tag = (kind: ActivityKind, at: unknown, doc: Record<string, unknown>): ActivityFeedItem => {
    const { kind: sendKind, ...rest } = doc;
    return { ...rest, kind, sendKind, at: (at as Date) ?? (doc.createdAt as Date) };
  };

  const merged: ActivityFeedItem[] = [
    ...tasks.map((t: any) => tag('task', t.dueDate, t)),
    ...tickets.map((t: any) => tag('ticket', t.createdAt, t)),
    ...calls.map((c: any) => tag('call', c.date, c)),
    ...meetings.map((m: any) => tag('meeting', m.startDate, m)),
    ...emails.map((e: any) => tag('email', e.sentAt, e)),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const page  = opts.page  ?? 1;
  const limit = opts.limit ?? 20;
  const total = merged.length;
  const start = (page - 1) * limit;
  const items = merged.slice(start, start + limit);

  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
