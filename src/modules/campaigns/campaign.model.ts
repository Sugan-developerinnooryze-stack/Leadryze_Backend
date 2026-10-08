import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaign extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  // LR-CAMP-001: the New Campaign form's Type select (broadcast/drip/
  // reengagement/followup) is a separate concept from which channel it
  // sends over — they used to share this one enum, which rejected every
  // one of the form's real Type options.
  type: 'broadcast' | 'drip' | 'reengagement' | 'followup';
  channel: 'email' | 'whatsapp' | 'sms' | 'instagram';
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  templateId?: mongoose.Types.ObjectId;
  audience: {
    // Drives resolveAudience() in campaign-dispatch.service.ts. Optional so
    // every pre-existing Campaign document (and every caller that only ever
    // set `filter`) keeps loading and behaving exactly as before.
    type?: 'all_customers' | 'filtered' | 'manual';
    filter: Record<string, unknown>;
    customerIds?: mongoose.Types.ObjectId[];
    estimatedCount?: number;
  };
  schedule?: { startAt: Date; endAt?: Date; timezone: string };
  stats: {
    total: number; sent: number; delivered: number; opened: number;
    clicked: number; replied: number; failed: number;
  };
  aiGenerated: boolean;
  createdBy: mongoose.Types.ObjectId;
  activatedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  lastError?: string;
}

const campaignSchema = new Schema<ICampaign>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['broadcast', 'drip', 'reengagement', 'followup'], required: true },
    channel: { type: String, enum: ['email', 'whatsapp', 'sms', 'instagram'], required: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled'],
      default: 'draft',
    },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
    audience: {
      type: { type: String, enum: ['all_customers', 'filtered', 'manual'] },
      filter: { type: Schema.Types.Mixed, default: {} },
      customerIds: [{ type: Schema.Types.ObjectId, ref: 'Customer' }],
      estimatedCount: Number,
    },
    schedule: {
      startAt: Date,
      endAt: Date,
      timezone: { type: String, default: 'Asia/Singapore' },
    },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    aiGenerated: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    activatedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    lastError: String,
  },
  { timestamps: true }
);

campaignSchema.index({ tenantId: 1, status: 1 });
campaignSchema.index({ tenantId: 1, createdAt: -1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', campaignSchema);
