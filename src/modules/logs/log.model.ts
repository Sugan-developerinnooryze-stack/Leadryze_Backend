import mongoose, { Schema, Document } from 'mongoose';

export interface IActivityLog extends Document {
  tenantId: mongoose.Types.ObjectId;
  service: 'ai' | 'backend';
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  message: string;
  metadata: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
  createdAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    service:  { type: String, enum: ['ai', 'backend'], required: true },
    level:    { type: String, enum: ['info', 'warn', 'error', 'debug'], default: 'info' },
    event:    { type: String, required: true },
    message:  { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    sessionId:{ type: String },
    userId:   { type: String },
  },
  { timestamps: true }
);

activityLogSchema.index({ tenantId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, service: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, level: 1 });
// Auto-delete logs older than 30 days
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const ActivityLog = mongoose.model<IActivityLog>('ActivityLog', activityLogSchema);
