import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const ticketSchema = new Schema(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:     { type: String, index: true },
    subject:      { type: String, required: true, trim: true },
    priority:     { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    // Stage validity is enforced at the service layer against the tenant's
    // own configured pipeline (native-crm/pipeline-config), not a fixed enum.
    ticketStatus: { type: String, default: 'open' },
    description:  { type: String },
    contactName:  { type: String, trim: true },
    tags:         [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:    { type: String },
    // Optional link to a real Field Service record (Customer/Quotation/Work
    // Order/Contract) so this ticket shows up in that record's Activity feed —
    // relatedId is the target's Mongo _id (not its human-facing *Id string),
    // matching the same convention already used by lead-conversion/Timeline.
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },
  },
  { timestamps: true }
);

ticketSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

ticketSchema.index({ tenantId: 1 });
ticketSchema.index({ tenantId: 1, ticketStatus: 1 });
ticketSchema.index({ tenantId: 1, priority: 1 });
ticketSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
