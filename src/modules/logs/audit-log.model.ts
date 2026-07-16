import mongoose, { Schema, Document } from 'mongoose';

export interface IAuditLog extends Document {
  tenantId?:   string;
  actorId:     string;
  actorEmail:  string;
  actorRole:   string;
  action:      string;
  target?:     string;
  targetId?:   string;
  detail?:     Record<string, unknown>;
  ip:          string;
  timestamp:   Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    tenantId:   { type: String, index: true },
    actorId:    { type: String, required: true },
    actorEmail: { type: String, required: true },
    actorRole:  { type: String, required: true },
    action:     { type: String, required: true, index: true },
    target:     { type: String },
    targetId:   { type: String },
    detail:     { type: Schema.Types.Mixed },
    ip:         { type: String, default: 'unknown' },
    timestamp:  { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

// Auto-delete after 90 days
AuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

export async function logAuditEvent(
  action: string,
  actor: { id: string; email: string; role: string; ip?: string },
  options?: {
    tenantId?: string;
    target?: string;
    targetId?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await AuditLog.create({
      tenantId:   options?.tenantId,
      actorId:    actor.id,
      actorEmail: actor.email,
      actorRole:  actor.role,
      action,
      target:     options?.target,
      targetId:   options?.targetId,
      detail:     options?.detail,
      ip:         actor.ip || 'unknown',
      timestamp:  new Date(),
    });
  } catch {
    // Never crash on audit failure
  }
}
