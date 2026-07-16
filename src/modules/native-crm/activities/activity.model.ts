import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IActivityDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:          number;
  activityId:     string;
  type:           'note' | 'call' | 'email' | 'visit' | 'task';
  subject:        string;
  description?:   string;
  relatedModule?: string;
  relatedId?:     string;
  scheduledAt?:   Date;
  completedAt?:   Date;
  assignedTo?:    string;
  status:         'pending' | 'completed' | 'cancelled';
  customFields?: Record<string, any>;
  createdBy?:     string;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<IActivityDoc>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:      { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:         { type: Number },
    activityId:    { type: String },
    type:          { type: String, enum: ['note', 'call', 'email', 'visit', 'task'], default: 'note' },
    subject:       { type: String, required: true, trim: true },
    description:   { type: String },
    relatedModule: { type: String, trim: true },
    relatedId:     { type: String, trim: true },
    scheduledAt:   { type: Date },
    completedAt:   { type: Date },
    assignedTo:    { type: String, trim: true },
    status:        { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:     { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any)
    .findOne({ tenantId: this.tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  this.numId      = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.activityId = `${pfx}-ACT-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, type: 1 });

export const NativeActivity = mongoose.model<IActivityDoc>(
  'NativeActivity',
  schema,
  'native_activities'
);

