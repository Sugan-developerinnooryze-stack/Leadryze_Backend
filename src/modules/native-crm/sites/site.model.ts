import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { encryptPIIFields } from '../../../platform/pii/pii.service';

export interface ISiteDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:          number;
  siteId:         string;
  name:           string;
  address:        string;
  city?:          string;
  state?:         string;
  postcode?:      string;
  country?:       string;
  customerId?:    mongoose.Types.ObjectId;
  contactPerson?: string;
  phone?:         string;
  notes?:         string;
  status:         'active' | 'inactive';
  latitude?:      number;
  longitude?:     number;
  customFields?: Record<string, any>;
  createdBy?:     string;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<ISiteDoc>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:      { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:         { type: Number },
    siteId:        { type: String },
    name:          { type: String, required: true, trim: true },
    address:       { type: String, required: true, trim: true },
    city:          { type: String, trim: true },
    state:         { type: String, trim: true },
    postcode:      { type: String, trim: true },
    country:       { type: String, trim: true },
    customerId:    { type: Schema.Types.ObjectId, ref: 'NativeCustomer' },
    contactPerson: { type: String, trim: true },
    phone:         { type: String, trim: true },
    notes:         { type: String },
    status:        { type: String, enum: ['active', 'inactive'], default: 'active' },
    latitude:      { type: Number },
    longitude:     { type: Number },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:     { type: String },
  },
  { timestamps: true }
);

schema.pre('save', function (next) {
  encryptPIIFields(this as any, 'sites');
  next();
});

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
  this.siteId = `${pfx}-SITE-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, customerId: 1 });
schema.index({ tenantId: 1, status: 1 });

export const NativeSite = mongoose.model<ISiteDoc>(
  'NativeSite',
  schema,
  'native_sites'
);

