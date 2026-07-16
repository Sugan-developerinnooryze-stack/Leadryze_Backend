import mongoose, { Schema, Document } from 'mongoose';

export interface ILockAuditDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  entityModule: string;
  entityId:    string;
  action:      'locked' | 'unlocked';
  reason:      string;
  performedBy: string;
  performedAt: Date;
}

const schema = new Schema<ILockAuditDoc>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    entityModule: { type: String, required: true },
    entityId:     { type: String, required: true },
    action:       { type: String, enum: ['locked', 'unlocked'], required: true },
    reason:       { type: String, required: true },
    performedBy:  { type: String, required: true },
    performedAt:  { type: Date, required: true },
  },
  { timestamps: false }
);

schema.index({ tenantId: 1, entityModule: 1, entityId: 1 });
schema.index({ tenantId: 1, performedAt: -1 });

export const LockAudit = mongoose.model<ILockAuditDoc>(
  'LockAudit',
  schema,
  'native_lock_audit'
);
