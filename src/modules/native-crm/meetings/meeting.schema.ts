import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const meetingSchema = new Schema(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:      { type: String, index: true },
    title:         { type: String, required: true, trim: true },
    startDate:     { type: Date },
    endDate:       { type: Date },
    location:      { type: String, trim: true },
    attendees:     [{ type: String }],
    meetingStatus: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' },
    notes:         { type: String },
    tags:          [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:     { type: String },
    // Optional link to a real Field Service record (Customer/Quotation/Work
    // Order/Contract) so this meeting shows up in that record's Activity feed
    // — relatedId is the target's Mongo _id (not its human-facing *Id
    // string), matching the same convention already used by
    // lead-conversion/Timeline.
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract', 'lead'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },
    // Guard so the "upcoming meeting" reminder cron never emails/texts twice
    // for the same meeting — same shape as the pre-existing
    // Activity.reminderSentAt.
    reminderSentAt: { type: Date },
    // Populated only for widget-booked meetings (bookWidgetMeeting()) — the
    // round-robin-assigned rep and where the booking came from. Optional/
    // additive, absent on every meeting created through the existing manual
    // Meeting form or automation engine.
    assignedStaffId:   { type: String, trim: true },
    assignedStaffName: { type: String, trim: true },
    source:            { type: String, enum: ['manual', 'widget'], default: 'manual' },
  },
  { timestamps: true }
);

meetingSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

meetingSchema.index({ tenantId: 1 });
meetingSchema.index({ tenantId: 1, meetingStatus: 1 });
meetingSchema.index({ tenantId: 1, startDate: 1 });
meetingSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
// Hard guarantee against double-booking the same widget slot under a race
// (two visitors booking the identical startDate at once) — scoped to
// scheduled widget bookings only, so staff manually double-booking
// themselves via the normal Meeting form (a legitimate, common thing) is
// completely unaffected.
meetingSchema.index(
  { tenantId: 1, startDate: 1 },
  { unique: true, partialFilterExpression: { source: 'widget', meetingStatus: 'scheduled' } }
);
