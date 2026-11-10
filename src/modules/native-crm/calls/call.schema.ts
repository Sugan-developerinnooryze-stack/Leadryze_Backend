import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { registerAssistantProvenanceHooks } from '../shared/assistant-provenance';

export const callSchema = new Schema(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:    { type: String, index: true },
    contactName: { type: String, required: true, trim: true },
    direction:   { type: String, enum: ['inbound', 'outbound'] },
    duration:    { type: Number },
    callStatus:  { type: String, enum: ['planned', 'completed', 'missed', 'cancelled'], default: 'planned' },
    date:        { type: Date },
    timezone:    { type: String, trim: true },
    notes:       { type: String },
    tags:        [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:   { type: String },
    // Optional link to a real Field Service record (Customer/Quotation/Work
    // Order/Contract) so this call shows up in that record's Activity feed —
    // relatedId is the target's Mongo _id (not its human-facing *Id string),
    // matching the same convention already used by lead-conversion/Timeline.
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract', 'lead'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },
    // Guard so the "upcoming call" reminder cron never emails/texts twice for
    // the same call — same shape as the pre-existing Activity.reminderSentAt.
    reminderSentAt: { type: Date },
    // CRM-assistant reminder pause (shared/assistant-provenance.ts): set only
    // by the internal CRM assistant gateway, in the same write, when it creates
    // the call or changes a reminder-relevant field. While the call's
    // reminder-relevant values still match the fingerprint, the reminder cron
    // and the on-create confirmation send nothing to the customer.
    // Server-managed and internal: no default (absent unless paused), never
    // selected unless asked for, and dropped from toJSON/toObject.
    assistantChangedAt:   { type: Date, select: false },
    assistantFingerprint: { type: String, select: false },
    // The reminder cron already logged "not sent" for the current pause.
    reminderSuppressedAt: { type: Date, select: false },
  },
  { timestamps: true }
);

registerAssistantProvenanceHooks(callSchema, 'call');

callSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

callSchema.index({ tenantId: 1 });
callSchema.index({ tenantId: 1, callStatus: 1 });
callSchema.index({ tenantId: 1, date: 1 });
callSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
