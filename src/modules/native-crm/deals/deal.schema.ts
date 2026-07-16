import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const dealSchema = new Schema(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:    { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:    { type: String, index: true },
    title:       { type: String, required: true, trim: true },
    amount:      { type: Number },
    currency:    { type: String, default: 'USD' },
    stage:       { type: String, enum: ['prospect', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'], required: true, default: 'prospect' },
    closeDate:   { type: Date },
    contactName: { type: String, trim: true },
    companyName: { type: String, trim: true },
    notes:       { type: String },
    tags:        [{ type: String }],
    customFields:  { type: Schema.Types.Mixed },
    createdBy:     { type: String },
    leadId:        { type: String },
    contactId:     { type: String },
    isLocked:   { type: Boolean, default: false, index: true },
    lockedAt:   { type: Date },
    lockedBy:   { type: String },
    lockReason: { type: String },
  },
  { timestamps: true }
);

dealSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

dealSchema.index({ tenantId: 1 });
dealSchema.index({ tenantId: 1, stage: 1 });
dealSchema.index({ tenantId: 1, closeDate: 1 });
