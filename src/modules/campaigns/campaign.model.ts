import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaign extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  type: 'email' | 'whatsapp' | 'sms' | 'multi-channel';
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  templateId?: mongoose.Types.ObjectId;
  audience: { filter: Record<string, unknown>; estimatedCount?: number };
  schedule?: { startAt: Date; endAt?: Date; timezone: string };
  stats: {
    sent: number; delivered: number; opened: number;
    clicked: number; replied: number; failed: number;
  };
  aiGenerated: boolean;
  createdBy: mongoose.Types.ObjectId;
}

const campaignSchema = new Schema<ICampaign>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['email', 'whatsapp', 'sms', 'multi-channel'], required: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed'],
      default: 'draft',
    },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
    audience: {
      filter: { type: Schema.Types.Mixed, default: {} },
      estimatedCount: Number,
    },
    schedule: {
      startAt: Date,
      endAt: Date,
      timezone: { type: String, default: 'Asia/Singapore' },
    },
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    aiGenerated: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

campaignSchema.index({ tenantId: 1, status: 1 });
campaignSchema.index({ tenantId: 1, createdAt: -1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', campaignSchema);
