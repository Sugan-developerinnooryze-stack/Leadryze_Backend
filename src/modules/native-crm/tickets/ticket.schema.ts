import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { getNextSequence } from '../shared/counter.model';

export const ticketSchema = new Schema(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:     { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:     { type: String, index: true },
    numId:        { type: Number },
    ticketId:     { type: String, index: true },
    ticketNumber: { type: String, index: true },
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
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract', 'lead'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },

    // SLA — server-computed only via ticket-sla-policy.service.ts's
    // computeDueDates(); never client-writable. slaStatus itself is NOT
    // stored (derived on read via deriveSlaStatus() from these fields, so it
    // can never drift from what it's computed from).
    resolutionDueAt:        { type: Date, default: null, index: true },
    firstResponseDueAt:     { type: Date, default: null },
    resolutionWarningAt:    { type: Date, default: null },
    firstResponseWarningAt: { type: Date, default: null },
    resolvedAt:              { type: Date, default: null },
    closedAt:                { type: Date, default: null },
    firstRespondedAt:       { type: Date, default: null },
  },
  { timestamps: true }
);

ticketSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  if (!this.numId) {
    this.numId = await getNextSequence(this.tenantId as mongoose.Types.ObjectId, 'tickets', this.constructor as any);
  }
  const pfx = this.clientId || (await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId));
  this.clientId = pfx;
  if (!this.ticketNumber) {
    const formatted = `${pfx}-TKT-${String(this.numId).padStart(4, '0')}`;
    this.ticketNumber = formatted;
    this.ticketId = formatted;
  }
  next();
});

ticketSchema.index({ tenantId: 1 });
ticketSchema.index({ tenantId: 1, ticketStatus: 1 });
ticketSchema.index({ tenantId: 1, priority: 1 });
ticketSchema.index({ tenantId: 1, ticketNumber: 1 });
ticketSchema.index({ tenantId: 1, ticketId: 1 });
ticketSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
