import mongoose, { Schema, Document } from 'mongoose';

export interface ISlaPriorityPolicy {
  priority: 'low' | 'medium' | 'high' | 'critical';
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

/** One document per tenant — tenant-editable first-response/resolution
 * minute targets per priority tier, plus the warning-threshold percentage
 * (the earlier of two SLA tiers — see ticket-sla-policy.service.ts's own
 * comment for why warning and breach are two independent automation
 * triggers, not one rule with two outcomes). */
export interface ITicketSlaPolicyDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  enabled:        boolean;
  /** What fraction of the way to the due date the "warning" timestamp sits
   * at — e.g. 80 means firstResponseWarningAt/resolutionWarningAt land at
   * 80% of the way from creation to the corresponding *DueAt. */
  warningPercent: number;
  policies:       ISlaPriorityPolicy[];
  createdAt:      Date;
  updatedAt:      Date;
}

const slaPriorityPolicySchema = new Schema<ISlaPriorityPolicy>(
  {
    priority:              { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    firstResponseMinutes:  { type: Number, required: true, min: 1 },
    resolutionMinutes:     { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const schema = new Schema<ITicketSlaPolicyDoc>(
  {
    tenantId:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    enabled:        { type: Boolean, default: true },
    warningPercent: { type: Number, default: 80, min: 1, max: 99 },
    policies:       { type: [slaPriorityPolicySchema], default: [] },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1 }, { unique: true });

export const TicketSlaPolicy = mongoose.model<ITicketSlaPolicyDoc>(
  'TicketSlaPolicy',
  schema,
  'native_ticket_sla_policies'
);
