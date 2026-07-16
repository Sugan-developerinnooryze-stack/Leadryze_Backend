import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IPartDoc extends Document {
  tenantId:     mongoose.Types.ObjectId;
  branchId?:    mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:        number;
  partId:       string;
  name:         string;
  partNumber?:  string;
  description?: string;
  price:        number;
  unit?:        string;
  quantity:     number;
  status:       'active' | 'inactive';
  customFields?: Record<string, any>;
  createdBy?:   string;
  createdAt:    Date;
  updatedAt:    Date;
}

const schema = new Schema<IPartDoc>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:    { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:       { type: Number },
    partId:      { type: String },
    name:        { type: String, required: true, trim: true },
    partNumber:  { type: String, trim: true },
    description: { type: String, trim: true },
    price:       { type: Number, default: 0, min: 0 },
    unit:        { type: String, trim: true },
    quantity:    { type: Number, default: 0, min: 0 },
    status:      { type: String, enum: ['active', 'inactive'], default: 'active' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:   { type: String },
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
  this.numId  = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.partId = `${pfx}-PT-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, partNumber: 1 });

export const NativePart = mongoose.model<IPartDoc>(
  'NativePart',
  schema,
  'native_parts'
);

