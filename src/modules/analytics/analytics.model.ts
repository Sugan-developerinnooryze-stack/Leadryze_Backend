import mongoose, { Schema, Document } from 'mongoose';

export interface IAnalytics extends Document {
  tenantId: mongoose.Types.ObjectId;
  date: Date;
  channel: string;
  metrics: {
    totalLeads: number;
    newLeads: number;
    qualifiedLeads: number;
    bookedLeads: number;
    lostLeads: number;
    messagesSent: number;
    messagesReceived: number;
    avgResponseTimeMs: number;
    conversionRate: number;
  };
}

const analyticsSchema = new Schema<IAnalytics>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    date: { type: Date, required: true },
    channel: { type: String, required: true },
    metrics: {
      totalLeads: { type: Number, default: 0 },
      newLeads: { type: Number, default: 0 },
      qualifiedLeads: { type: Number, default: 0 },
      bookedLeads: { type: Number, default: 0 },
      lostLeads: { type: Number, default: 0 },
      messagesSent: { type: Number, default: 0 },
      messagesReceived: { type: Number, default: 0 },
      avgResponseTimeMs: { type: Number, default: 0 },
      conversionRate: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

analyticsSchema.index({ tenantId: 1, date: -1, channel: 1 });

export const Analytics = mongoose.model<IAnalytics>('Analytics', analyticsSchema);
