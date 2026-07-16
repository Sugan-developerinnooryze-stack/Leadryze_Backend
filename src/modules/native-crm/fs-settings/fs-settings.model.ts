import mongoose, { Schema, Document } from 'mongoose';

export interface IFSSettingsDoc extends Document {
  tenantId:           mongoose.Types.ObjectId;
  branchId?:          mongoose.Types.ObjectId | null;
  companyName?:       string;
  companyLogo?:       string;
  gstin?:             string;
  pan?:               string;
  businessRegNumber?: string;
  companyEmail?:      string;
  phone?:             string;
  whatsapp?:          string;
  website?:           string;
  address1?:          string;
  address2?:          string;
  city?:              string;
  state?:             string;
  country?:           string;
  postalCode?:        string;
  timezone?:          string;
  currency?:          string;
  taxPercentage?:     number;
  invoicePrefix?:     string;
  quotationPrefix?:   string;
  workOrderPrefix?:   string;
  contractPrefix?:    string;
  receiptPrefix?:     string;
  bankName?:          string;
  accountName?:       string;
  accountNumber?:     string;
  ifscCode?:          string;
  branch?:            string;
  upiId?:             string;
  qrCodeImage?:       string;
  companySignature?:  string;
  stampImage?:        string;
  termsAndConditions?:string;
  invoiceFooter?:     string;
  quotationFooter?:   string;
  contractFooter?:    string;
  workorderFooter?:   string;
  workingDays?:       string[];
  autoClientIdPrefix?:string;
  lastClientNumId?:   number;
  // Workflow Engine
  workflowSteps?:           string[];
  autoGenerateWorkOrders?:  boolean;
  staffHardBlock?:          boolean;
  defaultDurationHours?:    number;
  activeTemplateId?:        string;
  // Record Locking
  lockingConfig?: Array<{
    module:           string;
    autoLock:         boolean;
    autoLockOnStatus: string;
    unlockRoles:      string[];
  }>;
  // PII Field Visibility
  piiConfig?: Array<{
    module:     string;    // 'customers' | 'leads' | 'contacts' | 'staffs' | 'sites'
    viewRoles:  string[];  // roles (beyond admins) that can see full values
  }>;
  createdAt:          Date;
  updatedAt:          Date;
}

const schema = new Schema<IFSSettingsDoc>(
  {
    tenantId:           { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:           { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    companyName:        { type: String, trim: true },
    companyLogo:        { type: String },
    gstin:              { type: String, trim: true },
    pan:                { type: String, trim: true },
    businessRegNumber:  { type: String, trim: true },
    companyEmail:       { type: String, trim: true, lowercase: true },
    phone:              { type: String, trim: true },
    whatsapp:           { type: String, trim: true },
    website:            { type: String, trim: true },
    address1:           { type: String, trim: true },
    address2:           { type: String, trim: true },
    city:               { type: String, trim: true },
    state:              { type: String, trim: true },
    country:            { type: String, trim: true },
    postalCode:         { type: String, trim: true },
    timezone:           { type: String, trim: true, default: 'UTC' },
    currency:           { type: String, trim: true, default: 'AUD' },
    taxPercentage:      { type: Number, default: 0, min: 0, max: 100 },
    invoicePrefix:      { type: String, trim: true, default: 'INV' },
    quotationPrefix:    { type: String, trim: true, default: 'QUO' },
    workOrderPrefix:    { type: String, trim: true, default: 'WO' },
    contractPrefix:     { type: String, trim: true, default: 'CON' },
    receiptPrefix:      { type: String, trim: true, default: 'RCP' },
    bankName:           { type: String, trim: true },
    accountName:        { type: String, trim: true },
    accountNumber:      { type: String, trim: true },
    ifscCode:           { type: String, trim: true },
    branch:             { type: String, trim: true },
    upiId:              { type: String, trim: true },
    qrCodeImage:        { type: String },
    companySignature:   { type: String },
    stampImage:         { type: String },
    termsAndConditions: { type: String },
    invoiceFooter:      { type: String },
    quotationFooter:    { type: String },
    contractFooter:     { type: String },
    workorderFooter:    { type: String },
    workingDays:        [{ type: String }],
    autoClientIdPrefix: { type: String, trim: true, default: 'LRZ' },
    lastClientNumId:    { type: Number, default: 100000 },
    // Workflow Engine
    workflowSteps:           { type: [String], default: ['quotation', 'workorder', 'invoice'] },
    autoGenerateWorkOrders:  { type: Boolean, default: false },
    staffHardBlock:          { type: Boolean, default: false },
    defaultDurationHours:    { type: Number, min: 0, default: 1 },
    activeTemplateId:        { type: String },
    // Record Locking
    lockingConfig: [{
      module:           { type: String },
      autoLock:         { type: Boolean, default: false },
      autoLockOnStatus: { type: String },
      unlockRoles:      [{ type: String }],
      _id: false,
    }],
    // PII Field Visibility
    piiConfig: [{
      module:    { type: String },
      viewRoles: [{ type: String }],
      _id: false,
    }],
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, branchId: 1 }, { unique: true });

export const FSSettings = mongoose.model<IFSSettingsDoc>(
  'FSSettings',
  schema,
  'native_fs_settings'
);
