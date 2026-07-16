import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { encryptPIIFields } from '../../../platform/pii/pii.service';

export type LeadStatus =
  | 'new' | 'contacted' | 'qualified' | 'meeting_scheduled'
  | 'proposal_sent' | 'negotiation' | 'won' | 'lost'
  | 'on_hold' | 'disqualified';

export type LeadSource =
  | 'website' | 'landing_page' | 'chatbot' | 'whatsapp' | 'facebook'
  | 'google' | 'manual' | 'csv' | 'api' | 'referral' | 'other';

export type LeadRating = 'hot' | 'warm' | 'cold';

export interface ILeadDoc extends Document {
  tenantId:      mongoose.Types.ObjectId;
  branchId?:     mongoose.Types.ObjectId | null;
  clientId?:     string;
  numId:         number;
  leadId:        string;

  // Identity
  firstName:     string;
  lastName?:     string;
  company?:      string;
  designation?:  string;
  industry?:     string;
  website?:      string;
  gstNumber?:    string;
  annualRevenue?: number;
  employeeCount?: number;

  // Contact
  email?:         string;
  secondaryEmail?: string;
  phone?:         string;
  mobile?:        string;
  whatsapp?:      string;
  alternatePhone?: string;
  linkedin?:      string;
  facebook?:      string;
  twitter?:       string;

  // Address
  address?:   string;
  address2?:  string;
  city?:      string;
  state?:     string;
  country?:   string;
  postalCode?: string;

  // Pipeline
  status:   LeadStatus;
  source:   LeadSource;
  rating:   LeadRating;
  score:    number;
  priority: 'high' | 'medium' | 'low';
  leadOwner?: string;

  // Sales
  expectedRevenue?:   number;
  expectedCloseDate?: Date;
  budget?:            number;
  interestedProducts?: string[];
  interestedServices?: string[];
  competitor?:        string;
  requirement?:       string;
  painPoints?:        string;
  decisionMaker?:     string;
  purchaseTimeline?:  string;
  lostReason?:        string;

  // Marketing attribution
  campaign?:         string;
  utmSource?:        string;
  utmMedium?:        string;
  utmCampaign?:      string;
  googleAdsId?:      string;
  facebookCampaign?: string;
  landingPage?:      string;

  // Conversion
  isConverted:          boolean;
  convertedCustomerId?: string;
  convertedAt?:         Date;
  contactId?:           string;
  opportunityId?:       string;
  conversionHistory?:   Array<{
    type:      'contact' | 'opportunity' | 'customer';
    entityId:  string;
    name:      string;
    createdAt: Date;
    createdBy: string;
  }>;

  // Record Locking
  isLocked?:    boolean;
  lockedAt?:    Date;
  lockedBy?:    string;
  lockReason?:  string;
  phoneSearch?: string;
  emailDomain?: string;

  // Meta
  tags:           string[];
  notes?:         string;
  customFields?:  Record<string, any>;
  createdBy?:     string;
  lastActivityAt?: Date;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<ILeadDoc>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:  { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:     { type: Number },
    leadId:    { type: String },

    firstName:    { type: String, required: true, trim: true },
    lastName:     { type: String, trim: true },
    company:      { type: String, trim: true },
    designation:  { type: String, trim: true },
    industry:     { type: String, trim: true },
    website:      { type: String, trim: true },
    gstNumber:    { type: String, trim: true },
    annualRevenue: { type: Number },
    employeeCount: { type: Number },

    email:          { type: String, trim: true, lowercase: true },
    secondaryEmail: { type: String, trim: true, lowercase: true },
    phone:          { type: String, trim: true },
    mobile:         { type: String, trim: true },
    whatsapp:       { type: String, trim: true },
    alternatePhone: { type: String, trim: true },
    linkedin:       { type: String, trim: true },
    facebook:       { type: String, trim: true },
    twitter:        { type: String, trim: true },

    address:    { type: String, trim: true },
    address2:   { type: String, trim: true },
    city:       { type: String, trim: true },
    state:      { type: String, trim: true },
    country:    { type: String, trim: true },
    postalCode: { type: String, trim: true },

    status:   { type: String, enum: ['new','contacted','qualified','meeting_scheduled','proposal_sent','negotiation','won','lost','on_hold','disqualified'], default: 'new' },
    source:   { type: String, enum: ['website','landing_page','chatbot','whatsapp','facebook','google','manual','csv','api','referral','other'], default: 'manual' },
    rating:   { type: String, enum: ['hot','warm','cold'], default: 'warm' },
    score:    { type: Number, default: 0, min: 0, max: 100 },
    priority: { type: String, enum: ['high','medium','low'], default: 'medium' },
    leadOwner: { type: String },

    expectedRevenue:   { type: Number },
    expectedCloseDate: { type: Date },
    budget:            { type: Number },
    interestedProducts: [{ type: String }],
    interestedServices: [{ type: String }],
    competitor:        { type: String, trim: true },
    requirement:       { type: String },
    painPoints:        { type: String },
    decisionMaker:     { type: String, trim: true },
    purchaseTimeline:  { type: String, trim: true },
    lostReason:        { type: String },

    campaign:         { type: String, trim: true },
    utmSource:        { type: String, trim: true },
    utmMedium:        { type: String, trim: true },
    utmCampaign:      { type: String, trim: true },
    googleAdsId:      { type: String, trim: true },
    facebookCampaign: { type: String, trim: true },
    landingPage:      { type: String, trim: true },

    isConverted:          { type: Boolean, default: false },
    convertedCustomerId:  { type: String },
    convertedAt:          { type: Date },
    contactId:            { type: String },
    opportunityId:        { type: String },
    conversionHistory:    [{
      type:      { type: String, enum: ['contact', 'opportunity', 'customer'] },
      entityId:  { type: String },
      name:      { type: String },
      createdAt: { type: Date, default: Date.now },
      createdBy: { type: String },
      _id: false,
    }],

    tags:         [{ type: String }],
    notes:        { type: String },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:    { type: String },
    lastActivityAt: { type: Date },
    isLocked:    { type: Boolean, default: false, index: true },
    lockedAt:    { type: Date },
    lockedBy:    { type: String },
    lockReason:  { type: String },
    phoneSearch: { type: String, index: true },
    emailDomain: { type: String, index: true },
  },
  { timestamps: true }
);

schema.pre('save', function (next) {
  encryptPIIFields(this as any, 'leads');
  next();
});

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any)
    .findOne({ tenantId: this.tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  this.numId    = (last?.numId ?? 0) + 1;
  const pfx     = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.leadId   = `${pfx}-LEAD-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, leadOwner: 1 });
schema.index({ tenantId: 1, isConverted: 1 });
schema.index({ tenantId: 1, leadId: 1 });

export const Lead = mongoose.model<ILeadDoc>('Lead', schema, 'native_leads');
