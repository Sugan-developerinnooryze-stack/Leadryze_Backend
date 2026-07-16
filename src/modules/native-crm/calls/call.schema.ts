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
