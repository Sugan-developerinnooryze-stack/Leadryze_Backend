import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IBranchDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  clientId?:   string;
  branchCode:  string;
  branchName:  string;
  branchType:  'headquarters' | 'branch' | 'warehouse';
  email?:      string;
  phone?:      string;
  gstin?:      string;
  pan?:        string;
  address1?:   string;
  address2?:   string;
  city?:       string;
  state?:      string;
  country?:    string;
  postalCode?: string;
  // Branding
  companyLogo?:  string;
  signature?:    string;
  stampImage?:   string;
  qrCodeImage?:  string;
  // Banking
  bankName?:      string;
  accountName?:   string;
  accountNumber?: string;
  ifscCode?:      string;
  bankBranch?:    string;
  upiId?:         string;
  // PDF / document settings
  invoicePrefix?:      string;
  quotationPrefix?:    string;
  workOrderPrefix?:    string;
  contractPrefix?:     string;
  termsAndConditions?: string;
  invoiceFooter?:      string;
  quotationFooter?:    string;
  contractFooter?:     string;
  workorderFooter?:    string;
  currency?:           string;
  timezone?:           string;
  taxPercentage?:      number;
  // Management
  managerId?: mongoose.Types.ObjectId;
  maxUsers?:  number;
  status:     'active' | 'inactive';
  createdAt:  Date;
  updatedAt:  Date;
}

const schema = new Schema<IBranchDoc>(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:   { type: String, index: true },
    branchCode: { type: String, required: true, trim: true },
    branchName: { type: String, required: true, trim: true },
    branchType: { type: String, enum: ['headquarters', 'branch', 'warehouse'], default: 'branch' },
    email:      { type: String, trim: true, lowercase: true },
    phone:      { type: String, trim: true },
    gstin:      { type: String, trim: true },
    pan:        { type: String, trim: true },
    address1:   { type: String, trim: true },
    address2:   { type: String, trim: true },
    city:       { type: String, trim: true },
    state:      { type: String, trim: true },
    country:    { type: String, trim: true },
    postalCode: { type: String, trim: true },
    // Branding
    companyLogo: { type: String },
    signature:   { type: String },
    stampImage:  { type: String },
    qrCodeImage: { type: String },
    // Banking
    bankName:      { type: String, trim: true },
    accountName:   { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifscCode:      { type: String, trim: true },
    bankBranch:    { type: String, trim: true },
    upiId:         { type: String, trim: true },
    // PDF
    invoicePrefix:      { type: String, trim: true },
    quotationPrefix:    { type: String, trim: true },
    workOrderPrefix:    { type: String, trim: true },
    contractPrefix:     { type: String, trim: true },
    termsAndConditions: { type: String },
    invoiceFooter:      { type: String },
    quotationFooter:    { type: String },
    contractFooter:     { type: String },
    workorderFooter:    { type: String },
    currency:           { type: String, trim: true },
    timezone:           { type: String, trim: true },
    taxPercentage:      { type: Number, min: 0, max: 100 },
    // Management
    managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    maxUsers:  { type: Number },
    status:    { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, branchCode: 1 }, { unique: true });
schema.index({ tenantId: 1, status: 1 });

export const Branch = mongoose.model<IBranchDoc>('Branch', schema, 'native_branches');
