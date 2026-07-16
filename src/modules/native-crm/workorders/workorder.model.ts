import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IServiceLine {
  name:         string;
  description?: string;
  amount:       number;
  count:        number;
}

export interface IPartLine {
  name:         string;
  description?: string;
  partNumber?:  string;
  amount:       number;
  count:        number;
}

export interface IChecklist {
  item:      string;
  completed: boolean;
}

export interface IWorkorderDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:          number;
  workOrderId:    string;
  customerId:     string;
  quotationId?:   string;
  contractId?:    string;
  contractVisitNumber?: number;
  siteId?:        string;
  teamId?:        string;
  staffId?:       string;
  staffIds?:      string[];
  title:          string;
  scheduledDate?: Date;
  completedDate?: Date;
  durationHours?: number;
  services:       IServiceLine[];
  parts:          IPartLine[];
  priority:       'low' | 'medium' | 'high';
  status:         'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  notes?:               string;
  termsAndConditions?:  string;
  checklists:           IChecklist[];
  photos:         string[];
  signatureUrl?:  string;
  skills?:        string[];
  workflowState?: 'pending' | 'in_progress' | 'complete';
  portalToken?:   string;
  customFields?: Record<string, any>;
  createdBy?:     string;
  isLocked?:   boolean;
  lockedAt?:   Date;
  lockedBy?:   string;
  lockReason?: string;
  createdAt:      Date;
  updatedAt:      Date;
}

const serviceLineSchema = new Schema<IServiceLine>(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    amount:      { type: Number, min: 0, default: 0 },
    count:       { type: Number, min: 1, default: 1 },
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

const schema = new Schema<IWorkorderDoc>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:     { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:        { type: Number },
    workOrderId:  { type: String },
    customerId:   { type: String, required: true, trim: true },
    quotationId:  { type: String, trim: true },
    contractId:   { type: String, trim: true },
    contractVisitNumber: { type: Number },
    siteId:       { type: String, trim: true },
    teamId:       { type: String, trim: true },
    staffId:      { type: String, trim: true },
    staffIds:     { type: [{ type: String, trim: true }], default: [] },
    title:        { type: String, required: true, trim: true },
    scheduledDate:{ type: Date },
    completedDate:{ type: Date },
    durationHours:{ type: Number, min: 0 },
    services:     { type: [serviceLineSchema], default: [] },
    parts:        { type: [partLineSchema], default: [] },
    priority: {
      type:    String,
      enum:    ['low', 'medium', 'high'],
      default: 'medium',
    },
    status: {
      type:    String,
      enum:    ['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'],
      default: 'draft',
    },
    notes:              { type: String },
    termsAndConditions: { type: String },
    checklists: {
      type: [{
        item:      { type: String, required: true },
        completed: { type: Boolean, default: false },
        _id:       false,
      }],
      default: [],
    },
    photos:       [{ type: String }],
    signatureUrl: { type: String },
    skills:        [{ type: String }],
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
  this.numId       = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.workOrderId = `${pfx}-WO-${String(this.numId).padStart(4, '0')}`;
  next();
});

// Keep staffId <-> staffIds in sync so legacy single-staff readers keep working
schema.pre('save', function (next) {
  if (this.staffIds?.length && !this.staffId) {
    this.staffId = this.staffIds[0];
  } else if (this.staffId && (!this.staffIds || this.staffIds.length === 0)) {
    this.staffIds = [this.staffId];
  }
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, customerId: 1 });
schema.index({ tenantId: 1, staffIds: 1 });

export const NativeWorkorder = mongoose.model<IWorkorderDoc>(
  'NativeWorkorder',
  schema,
  'native_workorders'
);

