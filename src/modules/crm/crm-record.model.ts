import mongoose, { Schema, Document } from 'mongoose';

export interface ICRMRecord extends Document {
  tenantId: mongoose.Types.ObjectId;
  channel: string;            // 'zoho', 'hubspot', 'mysql', etc.
  module: string;             // 'Accounts', 'Deals', 'Products', or any table name
  externalId: string;         // ID from source system
  displayName: string;        // primary label for display
  data: Record<string, unknown>; // ALL raw fields — schema-less
  syncedAt: Date;
}

const crmRecordSchema = new Schema<ICRMRecord>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    channel:     { type: String, required: true },
    module:      { type: String, required: true },
    externalId:  { type: String, required: true },
    displayName: { type: String, default: '' },
    data:        { type: Schema.Types.Mixed, default: {} },
    syncedAt:    { type: Date, default: Date.now },
  },
  { timestamps: true }
);

crmRecordSchema.index({ tenantId: 1, channel: 1, module: 1 });
crmRecordSchema.index({ tenantId: 1, channel: 1, module: 1, externalId: 1 }, { unique: true });
crmRecordSchema.index({ tenantId: 1, channel: 1, module: 1, displayName: 1 });

export const CRMRecord = mongoose.model<ICRMRecord>('CRMRecord', crmRecordSchema);
