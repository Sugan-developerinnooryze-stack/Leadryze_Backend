import mongoose, { Schema, Document } from 'mongoose';

export interface INativeCrmLog extends Document {
  tenantId:   string;
  clientId?:  string;
  actorId:    string;
  actorName:  string;
  actorRole:  string;
  action:     'create' | 'update' | 'delete' | 'error' | 'permission';
  module:     string;
  resourceId: string;
  before:     Record<string, unknown> | null;
  after:      Record<string, unknown> | null;
  changes:    Record<string, unknown> | null;
  error:      string | null;
  statusCode: number;
  ip:         string;
  url:        string;
  timestamp:  Date;
}

const NativeCrmLogSchema = new Schema<INativeCrmLog>(
  {
    tenantId:   { type: String, required: true, index: true },
    clientId:   { type: String, index: true },
    actorId:    { type: String, default: 'anonymous' },
    actorName:  { type: String, default: '' },
    actorRole:  { type: String, default: '' },
    action:     { type: String, enum: ['create', 'update', 'delete', 'error', 'permission'], required: true, index: true },
    module:     { type: String, required: true, index: true },
    resourceId: { type: String, default: '' },
    before:     { type: Schema.Types.Mixed, default: null },
    after:      { type: Schema.Types.Mixed, default: null },
    changes:    { type: Schema.Types.Mixed, default: null },
    error:      { type: String, default: null },
    statusCode: { type: Number, default: 200 },
    ip:         { type: String, default: 'unknown' },
    url:        { type: String, default: '' },
    timestamp:  { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

NativeCrmLogSchema.index({ tenantId: 1, timestamp: -1 });
NativeCrmLogSchema.index({ tenantId: 1, module: 1, timestamp: -1 });
NativeCrmLogSchema.index({ tenantId: 1, action: 1, timestamp: -1 });
// TTL — auto-delete after 90 days
NativeCrmLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7_776_000 });

export const NativeCrmLog = mongoose.model<INativeCrmLog>(
  'NativeCrmLog',
  NativeCrmLogSchema,
  'native_crm_logs',
);
