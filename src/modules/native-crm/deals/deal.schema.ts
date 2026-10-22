import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const dealSchema = new Schema(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:    { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:    { type: String, index: true },
    title:       { type: String, required: true, trim: true },
    amount:      { type: Number },
    currency:    { type: String },
    // Stage validity is enforced at the service layer against the tenant's
    // own configured pipeline (native-crm/pipeline-config), not a fixed
    // schema enum, so each tenant can have their own stage list.
    stage:       { type: String, required: true, default: 'prospect' },
    closeDate:   { type: Date },
    contactName: { type: String, trim: true },
    companyName: { type: String, trim: true },
    // NativeStaff.staffId of the assigned owner — same human-readable-ID
    // convention Custom Module relationship fields use, not a Mongo _id.
    // Lets automation rules resolve a real recipient for the 'assigned_user'
    // strategy (see automation-rule.service.ts's resolveAutomationRecipient).
    assignedStaffId: { type: String, index: true },
    notes:       { type: String },
    tags:        [{ type: String }],
    customFields:  { type: Schema.Types.Mixed },
    createdBy:     { type: String },
    leadId:        { type: String },
    contactId:     { type: String },
    companyId:     { type: String },
    importBatchId: { type: String, index: true },
    isLocked:   { type: Boolean, default: false, index: true },
    lockedAt:   { type: Date },
    lockedBy:   { type: String },
    lockReason: { type: String },
  },
  { timestamps: true, optimisticConcurrency: true }
);

dealSchema.pre('save', async function (next) {
  if (this.isNew && !this.clientId) {
    this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  }
  // LR-C4-DEAL-001: Resolve default currency from tenant FSSettings instead of hardcoding USD
  if (!this.currency && this.tenantId) {
    try {
      const fs = await mongoose.model('FSSettings').findOne({
        tenantId: this.tenantId,
        branchId: this.branchId || null,
      }).select('currency').lean() as { currency?: string } | null;

      if (fs?.currency) {
        this.currency = fs.currency;
      } else {
        const orgFs = await mongoose.model('FSSettings').findOne({
          tenantId: this.tenantId,
          branchId: null,
        }).select('currency').lean() as { currency?: string } | null;
        this.currency = orgFs?.currency || 'INR';
      }
    } catch {
      this.currency = 'INR';
    }
  }
  next();
});

dealSchema.index({ tenantId: 1 });
dealSchema.index({ tenantId: 1, stage: 1 });
dealSchema.index({ tenantId: 1, closeDate: 1 });
