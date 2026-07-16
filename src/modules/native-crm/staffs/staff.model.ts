import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { encryptPIIFields } from '../../../platform/pii/pii.service';

export interface IStaffDoc extends Document {
  tenantId:   mongoose.Types.ObjectId;
  branchId?:  mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:      number;
  staffId:    string;
  firstName:  string;
  lastName:   string;
  email?:     string;
  phone?:     string;
  teamId?:    mongoose.Types.ObjectId;
  role?:      string;
  status:     'active' | 'inactive' | 'onleave';
  skills?:    string[];
  location?:  { lat: number; lng: number; updatedAt: Date };
  customFields?: Record<string, any>;
  createdBy?: string;
  // Staff mobile-app credentials (never plaintext; managed via app-credentials.service)
  appUsername?:               string;
  appPasswordHash?:           string;
  appPasswordEnc?:            string;
  appCredentialsGeneratedAt?: Date;
  appLastLoginAt?:            Date;
  createdAt:  Date;
  updatedAt:  Date;
}

const schema = new Schema<IStaffDoc>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:  { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:     { type: Number },
    staffId:   { type: String },
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, trim: true, lowercase: true },
    phone:     { type: String, trim: true },
    teamId:    { type: Schema.Types.ObjectId, ref: 'NativeTeam' },
    role:      { type: String, trim: true },
    status:    { type: String, enum: ['active', 'inactive', 'onleave'], default: 'active' },
    skills:    [{ type: String }],
    location:  {
      lat:       { type: Number },
      lng:       { type: Number },
      updatedAt: { type: Date },
    },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: String },
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
  encryptPIIFields(this as any, 'staffs');
  next();
});

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any)
    .findOne({ tenantId: this.tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  this.numId   = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.staffId = `${pfx}-ST-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, teamId: 1 });
schema.index(
  { tenantId: 1, appUsername: 1 },
  { unique: true, partialFilterExpression: { appUsername: { $type: 'string' } } }
);

export const NativeStaff = mongoose.model<IStaffDoc>(
  'NativeStaff',
  schema,
  'native_staffs'
);

