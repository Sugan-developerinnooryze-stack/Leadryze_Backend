import mongoose from 'mongoose';
import { TicketTimelineEvent, TicketTimelineEventType } from './ticket-timeline.model';

export async function logTimelineEvent(params: {
  tenantId: string; ticketId: string; eventType: TicketTimelineEventType;
  field?: string; fromValue?: string; toValue?: string; actorId?: string; actorName?: string;
}): Promise<void> {
  try {
    await TicketTimelineEvent.create({
      tenantId: new mongoose.Types.ObjectId(params.tenantId),
      ticketId: new mongoose.Types.ObjectId(params.ticketId),
      eventType: params.eventType,
      field: params.field,
      fromValue: params.fromValue,
      toValue: params.toValue,
      actorId: params.actorId,
      actorName: params.actorName,
    });
  } catch {
    // Non-critical — a timeline-logging failure must never block the actual
    // ticket mutation that triggered it.
  }
}

export async function listTimelineEvents(tenantId: string, ticketId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return TicketTimelineEvent.find({ tenantId: tid, ticketId: new mongoose.Types.ObjectId(ticketId) })
    .sort({ createdAt: -1 })
    .lean();
}

const TRACKED_FIELDS: Array<{ key: string; eventType: TicketTimelineEventType; label: string }> = [
  { key: 'ticketStatus', eventType: 'status_changed',   label: 'Status' },
  { key: 'priority',     eventType: 'priority_changed', label: 'Priority' },
  { key: 'staffId',      eventType: 'assigned',         label: 'Staff' },
  { key: 'teamId',       eventType: 'assigned',         label: 'Team' },
  { key: 'categoryId',   eventType: 'category_changed', label: 'Category' },
];

/** Diffs prev vs next ticket field values and logs one timeline event per
 * changed tracked field — called from ticket.service.ts's updateTicket()
 * right after a successful save, given both the pre-update and post-update
 * documents. */
export async function diffAndLogTicketChanges(
  tenantId: string, ticketId: string, prev: Record<string, any>, next: Record<string, any>,
  actor?: { id?: string; name?: string },
): Promise<void> {
  for (const c of TRACKED_FIELDS) {
    const before = String(prev[c.key] ?? '');
    const after = String(next[c.key] ?? '');
    if (before === after) continue;
    await logTimelineEvent({
      tenantId, ticketId, eventType: c.eventType, field: c.label,
      fromValue: before || undefined, toValue: after || undefined,
      actorId: actor?.id, actorName: actor?.name,
    });
  }
}
