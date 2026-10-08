import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { encryptPIIFields } from '../../../platform/pii/pii.service';

export const contactSchema = new Schema(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:  { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true },
    phone:     { type: String, trim: true },
    // LR-LEAD-005/CONTACT-004: blind-index fields so a Contact can be found
    // by email/phone even while those columns are encrypted — same purpose
    // as Lead's own phoneSearch/emailDomain (pii.service.ts).
    phoneSearch: { type: String, index: true },
    emailDomain: { type: String },
    emailSearch: { type: String, index: true },
    company:   { type: String, trim: true },
    // LR-CONTACT-001: real ID link to a native-crm Company, alongside the
    // existing free-text `company` (kept for display/back-compat, same
    // pattern as Deal's companyName + companyId).
    companyId: { type: String },
    jobTitle:  { type: String, trim: true },
    // LR-CONTACT-001/LR-RULE-003: now a platform User._id (CRM/sales user),
    // not free text — the field itself was always a plain String, so this
    // is a data-contract change going forward, not a schema change.
    contactOwner:   { type: String, trim: true },
    lifecycleStage: {
      type: String,
      enum: ['subscriber','lead','marketing_qualified_lead','sales_qualified_lead','opportunity','customer','evangelist','other'],
    },
    leadStatus: {
      type: String,
      enum: ['new','open','in_progress','open_deal','unqualified','attempted_to_contact','connected','bad_timing'],
    },
    status:    { type: String, enum: ['lead', 'contact', 'customer'], default: 'lead' },
    source:    { type: String, enum: ['website', 'referral', 'social', 'email', 'cold', 'other'] },
    notes:     { type: String },
    tags:      [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:    { type: String },
    leadId:       { type: String },
    isLocked:   { type: Boolean, default: false, index: true },
    lockedAt:   { type: Date },
    lockedBy:   { type: String },
    lockReason: { type: String },
  },
  { timestamps: true, optimisticConcurrency: true }
);

contactSchema.pre('save', function (next) {
  encryptPIIFields(this as any, 'contacts');
  next();
});

contactSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

contactSchema.index({ tenantId: 1 });
contactSchema.index({ tenantId: 1, status: 1 });
contactSchema.index({ tenantId: 1, email: 1 });
contactSchema.index({ tenantId: 1, firstName: 1, lastName: 1 });
