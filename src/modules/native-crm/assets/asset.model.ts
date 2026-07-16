import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IAssetDoc extends Document {
  tenantId:        mongoose.Types.ObjectId;
  branchId?:       mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:           number;
  assetId:         string;
  name:            string;
  category?:       string;
  serialNumber?:   string;
  purchaseDate?:   Date;
  warrantyExpiry?: Date;
  assignedTo?:     string;
  currentSite?:    string;
  condition?:      'new' | 'good' | 'fair' | 'poor';
  notes?:          string;
  status:          'active' | 'in_use' | 'under_maintenance' | 'retired';
  customFields?: Record<string, any>;
  createdBy?:      string;
  createdAt:       Date;
  updatedAt:       Date;
}

const schema = new Schema<IAssetDoc>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:      { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:         { type: Number },
    assetId:       { type: String },
    name:          { type: String, required: true, trim: true },
    category:      { type: String, trim: true },
    serialNumber:  { type: String, trim: true },
    purchaseDate:  { type: Date },
    warrantyExpiry:{ type: Date },
    assignedTo:    { type: String, trim: true },
    currentSite:   { type: String, trim: true },
    condition:     { type: String, enum: ['new', 'good', 'fair', 'poor'] },
    notes:         { type: String },
    status:        { type: String, enum: ['active', 'in_use', 'under_maintenance', 'retired'], default: 'active' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:     { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any).findOne({ tenantId: this.tenantId }).sort({ numId: -1 }).select('numId').lean();
  this.numId   = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.assetId = `${pfx}-AST-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });

export const NativeAsset = mongoose.model<IAssetDoc>('NativeAsset', schema, 'native_assets');

