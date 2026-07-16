import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface ITimelineDoc extends Document {
  tenantId:     mongoose.Types.ObjectId;
  clientId?:    string;
  entityModule: string;
  entityId:     string;
  action:       'created' | 'updated' | 'deleted' | 'status_changed' | 'note_added' | 'assigned' | 'uploaded' | 'locked' | 'unlocked';
  description:  string;
  performedBy?: string;
  metadata?:    Record<string, any>;
  createdAt:    Date;
}

const schema = new Schema<ITimelineDoc>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:     { type: String, index: true },
    entityModule: { type: String, required: true },
    entityId:     { type: String, required: true },
    action:       { type: String, enum: ['created','updated','deleted','status_changed','note_added','assigned','uploaded','locked','unlocked'], required: true },
    description:  { type: String, required: true },
    performedBy:  { type: String },
    metadata:     { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, entityModule: 1, entityId: 1 });
schema.index({ tenantId: 1, createdAt: -1 });

export const NativeTimeline = mongoose.model<ITimelineDoc>(
  'NativeTimeline',
  schema,
  'native_timeline'
);
