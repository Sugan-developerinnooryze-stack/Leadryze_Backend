import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const ticketSchema = new Schema(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:     { type: String, index: true },
    subject:      { type: String, required: true, trim: true },
    priority:     { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    ticketStatus: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
    description:  { type: String },
    contactName:  { type: String, trim: true },
    tags:         [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:    { type: String },
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
