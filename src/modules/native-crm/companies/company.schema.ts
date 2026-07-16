import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const companySchema = new Schema(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:      { type: String, index: true },
    name:          { type: String, required: true, trim: true },
    domain:        { type: String, trim: true },
    industry:      { type: String, trim: true },
    employeeCount: { type: Number },
    phone:         { type: String, trim: true },
    website:       { type: String, trim: true },
    city:          { type: String, trim: true },
    country:       { type: String, trim: true },
    companyStatus: { type: String, enum: ['active', 'inactive', 'prospect'], default: 'active' },
    notes:         { type: String },
    tags:          [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:     { type: String },
  },
  { timestamps: true }
);

companySchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

companySchema.index({ tenantId: 1 });
companySchema.index({ tenantId: 1, companyStatus: 1 });
companySchema.index({ tenantId: 1, name: 1 });
