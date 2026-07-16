import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { encryptPIIFields } from '../../../platform/pii/pii.service';

export interface ICustomerDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  branchId?:   mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:       number;
  customerId:  string;
  name:        string;
  company?:    string;
  designation?: string;
  email?:      string;
  phone?:      string;
  mobile?:     string;
  website?:    string;
  address?:    string;
  city?:       string;
  state?:      string;
  postcode?:   string;
  country?:    string;
  notes?:      string;
  tags?:       string[];
  status:      'active' | 'inactive';
  customFields?: Record<string, any>;
  createdBy?:     string;
  leadId?:        string;
  opportunityId?: string;
  isLocked?:    boolean;
  lockedAt?:    Date;
  lockedBy?:    string;
  lockReason?:  string;
  phoneSearch?: string;
  emailDomain?: string;
  // Customer mobile-app credentials (never plaintext; managed via app-credentials.service)
  appUsername?:               string;
  appPasswordHash?:           string;
  appPasswordEnc?:            string;
  appCredentialsGeneratedAt?: Date;
  appLastLoginAt?:            Date;
  createdAt:    Date;
  updatedAt:    Date;
}

const schema = new Schema<ICustomerDoc>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:    { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:    { type: String, index: true },
    numId:       { type: Number },
    customerId:  { type: String },
    name:        { type: String, required: true, trim: true },
    company:     { type: String, trim: true },
    designation: { type: String, trim: true },
    email:       { type: String, trim: true, lowercase: true },
    phone:       { type: String, trim: true },
    mobile:      { type: String, trim: true },
    website:     { type: String, trim: true },
    address:     { type: String, trim: true },
    city:        { type: String, trim: true },
    state:       { type: String, trim: true },
    postcode:    { type: String, trim: true },
    country:     { type: String, trim: true },
    notes:       { type: String },
    tags:        [{ type: String }],
    status:      { type: String, enum: ['active', 'inactive'], default: 'active' },
    customFields:  { type: Schema.Types.Mixed, default: {} },
    createdBy:     { type: String },
    leadId:        { type: String },
    opportunityId: { type: String },
    isLocked:    { type: Boolean, default: false, index: true },
    lockedAt:    { type: Date },
    lockedBy:    { type: String },
    lockReason:  { type: String },
    phoneSearch: { type: String, index: true },   // first 6 digits unencrypted for search
    emailDomain: { type: String, index: true },   // domain part unencrypted for search
    // App credentials — select:false keeps secrets out of every list/get response
    appUsername:               { type: String, trim: true, lowercase: true },
    appPasswordHash:           { type: String, select: false },
    appPasswordEnc:            { type: String, select: false },
    appCredentialsGeneratedAt: { type: Date },
    appLastLoginAt:            { type: Date },
  },
  { timestamps: true }
);

schema.pre('save', function (next) {
  encryptPIIFields(this as any, 'customers');
  next();
});

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any)
    .findOne({ tenantId: this.tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  this.numId      = (last?.numId ?? 0) + 1;
  const pfx       = await resolveClientPrefix(this.tenantId);
  this.clientId   = pfx;
  this.customerId = `${pfx}-CUS-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, email: 1 });
schema.index(
  { tenantId: 1, appUsername: 1 },
  { unique: true, partialFilterExpression: { appUsername: { $type: 'string' } } }
);

export const NativeCustomer = mongoose.model<ICustomerDoc>(
  'NativeCustomer',
  schema,
  'native_customers'
);
