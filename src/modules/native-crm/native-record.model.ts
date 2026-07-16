import mongoose, { Schema, Document } from 'mongoose';
import { NativeModule } from './native-crm.config';

export interface INativeRecord extends Document {
  tenantId:    mongoose.Types.ObjectId;
  module:      NativeModule;
  displayName: string;
  status:      string;
  fields:      Record<string, unknown>;
  tags?:       string[];
  createdBy?:  string;
}

const nativeRecordSchema = new Schema<INativeRecord>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    module:      {
      type: String,
      enum: ['contacts', 'companies', 'deals', 'tasks', 'tickets', 'calls', 'meetings'],
      required: true,
    },
    displayName: { type: String, required: true, trim: true },
    status:      { type: String, default: '' },
    fields:      { type: Schema.Types.Mixed, default: {} },
    tags:        [String],
    createdBy:   String,
  },
  { timestamps: true }
);

nativeRecordSchema.index({ tenantId: 1, module: 1 });
nativeRecordSchema.index({ tenantId: 1, module: 1, status: 1 });
nativeRecordSchema.index({ tenantId: 1, module: 1, displayName: 1 });

export const NativeRecord = mongoose.model<INativeRecord>('NativeRecord', nativeRecordSchema, 'nativecrmrecords');
