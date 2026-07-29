import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const callSchema = new Schema(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:    { type: String, index: true },
    contactName: { type: String, required: true, trim: true },
    direction:   { type: String, enum: ['inbound', 'outbound'] },
    duration:    { type: Number },
    callStatus:  { type: String, enum: ['planned', 'completed', 'missed', 'cancelled'], default: 'planned' },
    date:        { type: Date },
    notes:       { type: String },
    tags:        [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:   { type: String },
    // Optional link to a real Field Service record (Customer/Quotation/Work
    // Order/Contract) so this call shows up in that record's Activity feed —
    // relatedId is the target's Mongo _id (not its human-facing *Id string),
    // matching the same convention already used by lead-conversion/Timeline.
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },
    // Guard so the "upcoming call" reminder cron never emails/texts twice for
    // the same call — same shape as the pre-existing Activity.reminderSentAt.
    reminderSentAt: { type: Date },
  },
  { timestamps: true }
);

callSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

callSchema.index({ tenantId: 1 });
callSchema.index({ tenantId: 1, callStatus: 1 });
callSchema.index({ tenantId: 1, date: 1 });
callSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
