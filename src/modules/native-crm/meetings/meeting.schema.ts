import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const meetingSchema = new Schema(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:      { type: String, index: true },
    title:         { type: String, required: true, trim: true },
    startDate:     { type: Date },
    endDate:       { type: Date },
    location:      { type: String, trim: true },
    attendees:     [{ type: String }],
    meetingStatus: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' },
    notes:         { type: String },
    tags:          [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:     { type: String },
  },
  { timestamps: true }
);

meetingSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

meetingSchema.index({ tenantId: 1 });
meetingSchema.index({ tenantId: 1, meetingStatus: 1 });
meetingSchema.index({ tenantId: 1, startDate: 1 });
