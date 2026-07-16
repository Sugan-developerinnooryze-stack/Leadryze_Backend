import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IServiceLine {
  name:         string;
  description?: string;
  amount:       number;
  count:        number;
}

/** Rule-based schedule definition — one per contract service line. Never hardcoded. */
export interface IScheduleRule {
  frequency: 'once' | 'daily' | 'weekly' | 'fortnightly' | 'monthly' | 'bimonthly'
           | 'quarterly' | 'halfyearly' | 'yearly' | 'custom_interval' | 'custom_dates';
  weekdays?:   number[];          // weekly/fortnightly: 0(Sun)–6(Sat)
  dayOfMonth?: number | 'last';   // monthly+ anchor day (default: startDate's day)
  months?:     number[];          // quarterly/halfyearly/yearly anchor months (1–12)
  everyNDays?: number;            // custom_interval
  dates?:      string[];          // custom_dates: explicit ISO dates
}

/** Contract service line — extends the base line with its own schedule rule. */
export interface IContractServiceLine extends IServiceLine {
  scheduleRule?:    IScheduleRule;
  durationHours?:   number;   // per-visit duration for this service
  taxPercent?:      number;
  discountPercent?: number;
  requiredSkill?:   string;
  serviceId?:       string;   // catalog link
}

/** One generated schedule occurrence ("visit"). */
export interface IContractVisit {
  visitNumber: number;
  serviceDate: Date;
  services: { name: string; amount: number; count: number; durationHours?: number; serviceId?: string; frequency?: string }[];
  amount:      number;
  status:      'planned' | 'scheduled' | 'completed' | 'cancelled';
  workOrderId?: string;   // human code e.g. BADE2FF4-WO-0001
  woId?:        string;   // workorder Mongo _id
  notes?:       string;
}

export interface IPartLine {
  name:         string;
  description?: string;
  partNumber?:  string;
  amount:       number;
  count:        number;
}

export interface IContractDoc extends Document {
  tenantId:              mongoose.Types.ObjectId;
  branchId?:             mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:                 number;
  contractId:            string;
  customerId:            string;
  quotationId?:          string;
  title:                 string;
  siteId?:               string;
  staffId?:              string;
  teamId?:               string;
  startDate?:            Date;
  endDate?:              Date;
  noEndDate?:            boolean;
  services:              IContractServiceLine[];
  parts:                 IPartLine[];
  partsAmount:           number;
  contractType?:         'amc' | 'maintenance' | 'rental' | 'warranty' | 'preventive' | 'corrective' | 'installation' | 'inspection' | 'custom';
  priority?:             'low' | 'medium' | 'high' | 'critical';
  staffIds?:             string[];
  renewalType?:          'manual' | 'automatic';
  renewBeforeDays?:      number;
  woGenerationMode?:     'manual' | 'on_visit_day' | 'days_before';
  woLeadDays?:           number;
  visits?:               IContractVisit[];
  serviceFrequency?:     string;
  recurringUnit?:        'day' | 'week' | 'fortnight' | 'month' | 'bimonthly' | 'quarter' | 'halfyear' | 'year' | 'custom';
  recurringInterval?:    number;
  nextServiceDate?:      Date;
  lastServiceDate?:      Date;
  autoWoGenerated?:      number;
  discount:              number;
  gstPercentage:         number;
  servicesAmount:        number;
  servicesAmountWithTax: number;
  status:                'draft' | 'pending' | 'active' | 'suspended' | 'completed' | 'expired' | 'cancelled';
  notes?:                string;
  termsAndConditions?:   string;
  workflowState?: 'pending' | 'in_progress' | 'complete';
  portalToken?:   string;
  customFields?: Record<string, any>;
  createdBy?:            string;
  isLocked?:   boolean;
  lockedAt?:   Date;
  lockedBy?:   string;
  lockReason?: string;
  createdAt:             Date;
  updatedAt:             Date;
}

const scheduleRuleSchema = new Schema<IScheduleRule>(
  {
    frequency: {
      type: String,
      enum: ['once', 'daily', 'weekly', 'fortnightly', 'monthly', 'bimonthly',
             'quarterly', 'halfyearly', 'yearly', 'custom_interval', 'custom_dates'],
      required: true,
    },
    weekdays:   [{ type: Number, min: 0, max: 6 }],
    dayOfMonth: { type: Schema.Types.Mixed },   // number | 'last'
    months:     [{ type: Number, min: 1, max: 12 }],
    everyNDays: { type: Number, min: 1 },
    dates:      [{ type: String }],
  },
  { _id: false }
);

const serviceLineSchema = new Schema<IContractServiceLine>(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    amount:      { type: Number, min: 0, default: 0 },
    count:       { type: Number, min: 1, default: 1 },
    scheduleRule:    { type: scheduleRuleSchema },
    durationHours:   { type: Number, min: 0 },
    taxPercent:      { type: Number, min: 0 },
    discountPercent: { type: Number, min: 0 },
    requiredSkill:   { type: String, trim: true },
    serviceId:       { type: String, trim: true },
  },
  { _id: false }
);

const visitServiceSchema = new Schema(
  {
    name:          { type: String, required: true, trim: true },
    amount:        { type: Number, default: 0 },
    count:         { type: Number, default: 1 },
    durationHours: { type: Number },
    serviceId:     { type: String, trim: true },
    frequency:     { type: String, trim: true },   // schedule rule frequency — used for grouped display
  },
  { _id: false }
);

const visitSchema = new Schema<IContractVisit>(
  {
    visitNumber: { type: Number, required: true },
    serviceDate: { type: Date, required: true },
    services:    { type: [visitServiceSchema], default: [] },
    amount:      { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ['planned', 'scheduled', 'completed', 'cancelled'],
      default: 'planned',
    },
    workOrderId: { type: String, trim: true },
    woId:        { type: String, trim: true },
    notes:       { type: String, trim: true },
  },
  { _id: false }
);

const partLineSchema = new Schema(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    partNumber:  { type: String, trim: true },
    amount:      { type: Number, min: 0, default: 0 },
    count:       { type: Number, min: 1, default: 1 },
  },
  { _id: false }
);

const schema = new Schema<IContractDoc>(
  {
    tenantId:              { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:              { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:                 { type: Number },
    contractId:            { type: String },
    customerId:            { type: String, required: true, trim: true },
    quotationId:           { type: String, trim: true },
    siteId:                { type: String, trim: true },
    staffId:               { type: String, trim: true },
    teamId:                { type: String, trim: true },
    title:                 { type: String, required: true, trim: true },
    startDate:             { type: Date },
    endDate:               { type: Date },
    noEndDate:             { type: Boolean, default: false },
    services:              { type: [serviceLineSchema], default: [] },
    parts:                 { type: [partLineSchema], default: [] },
    partsAmount:           { type: Number, default: 0 },
    contractType: {
      type: String,
      enum: ['amc', 'maintenance', 'rental', 'warranty', 'preventive', 'corrective', 'installation', 'inspection', 'custom'],
    },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
    staffIds:         { type: [{ type: String, trim: true }], default: [] },
    renewalType:      { type: String, enum: ['manual', 'automatic'] },
    renewBeforeDays:  { type: Number, min: 0 },
    woGenerationMode: { type: String, enum: ['manual', 'on_visit_day', 'days_before'] },
    woLeadDays:       { type: Number, min: 0 },
    visits:           { type: [visitSchema], default: [] },
    serviceFrequency:      { type: String, trim: true },
    recurringUnit: {
      type: String,
      enum: ['day', 'week', 'fortnight', 'month', 'bimonthly', 'quarter', 'halfyear', 'year', 'custom'],
    },
    recurringInterval:     { type: Number, min: 1 },
    nextServiceDate:       { type: Date },
    lastServiceDate:       { type: Date },
    autoWoGenerated:       { type: Number, default: 0 },
    discount:              { type: Number, default: 0 },
    gstPercentage:         { type: Number, default: 0 },
    servicesAmount:        { type: Number, default: 0 },
    servicesAmountWithTax: { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ['draft', 'pending', 'active', 'suspended', 'completed', 'expired', 'cancelled'],
      default: 'draft',
    },
    notes:              { type: String },
    termsAndConditions: { type: String },
    workflowState: { type: String, enum: ['pending', 'in_progress', 'complete'], default: 'pending' },
    portalToken:   { type: String, unique: true, sparse: true, index: true },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: String },
    isLocked:   { type: Boolean, default: false, index: true },
    lockedAt:   { type: Date },
    lockedBy:   { type: String },
    lockReason: { type: String },
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
  this.numId      = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.contractId = `${pfx}-CON-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, customerId: 1 });
schema.index({ tenantId: 1, 'visits.serviceDate': 1, 'visits.status': 1 });

export const NativeContract = mongoose.model<IContractDoc>(
  'NativeContract',
  schema,
  'native_contracts'
);

