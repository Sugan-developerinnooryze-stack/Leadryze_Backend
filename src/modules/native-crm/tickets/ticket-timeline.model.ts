import mongoose, { Schema, Document } from 'mongoose';

export type TicketTimelineEventType =
  | 'created' | 'status_changed' | 'priority_changed' | 'assigned' | 'category_changed'
  | 'note_added' | 'attachment_added' | 'attachment_removed'
  | 'sla_warning' | 'sla_breached';

/** One append-only entry per tracked change to a Ticket — a real, confirmed
 * gap this closes: neither activity-feed.service.ts (records that LINK TO a
 * ticket) nor activities/activity.model.ts (a manually-logged note/call/
 * email/visit/task record type of its own) actually track field-level
 * changes ON a ticket over time. See ticket-timeline.service.ts's
 * diffAndLogTicketChanges() for what populates this automatically. */
export interface ITicketTimelineEventDoc extends Document {
  tenantId:   mongoose.Types.ObjectId;
  ticketId:   mongoose.Types.ObjectId;
  eventType:  TicketTimelineEventType;
  field?:     string;
  fromValue?: string;
  toValue?:   string;
  actorId?:   string;
  actorName?: string;
  createdAt:  Date;
}

const schema = new Schema<ITicketTimelineEventDoc>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    ticketId:  { type: Schema.Types.ObjectId, ref: 'CrmTicket', required: true },
    eventType: {
      type: String, required: true,
      enum: ['created', 'status_changed', 'priority_changed', 'assigned', 'category_changed', 'note_added', 'attachment_added', 'attachment_removed', 'sla_warning', 'sla_breached'],
    },
    field:     { type: String, trim: true },
    fromValue: { type: String, trim: true },
    toValue:   { type: String, trim: true },
    actorId:   { type: String, trim: true },
    actorName: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

schema.index({ tenantId: 1, ticketId: 1, createdAt: -1 });

export const TicketTimelineEvent = mongoose.model<ITicketTimelineEventDoc>(
  'TicketTimelineEvent',
  schema,
  'native_ticket_timeline_events'
);
