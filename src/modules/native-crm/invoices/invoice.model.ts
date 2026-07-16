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

export interface IInvoiceDoc extends Document {
  tenantId:              mongoose.Types.ObjectId;
  branchId?:             mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:                 number;
  invoiceId:             string;
  customerId:            string;
  workOrderId?:          string;
  quotationId?:          string;
  contractId?:           string;
  address?:              string;
  services:              IServiceLine[];
  parts:                 IPartLine[];
  partsAmount:           number;
  discount:              number;
  gstPercentage:         number;
  servicesAmount:        number;
  servicesAmountWithTax: number;
  dueDate?:              Date;
  paid:                  boolean;
  status:                'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
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

const schema = new Schema<IInvoiceDoc>(
  {
    tenantId:              { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:              { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:                 { type: Number },
    invoiceId:             { type: String },
    customerId:            { type: String, required: true, trim: true },
    workOrderId:           { type: String, trim: true },
    quotationId:           { type: String, trim: true },
    contractId:            { type: String, trim: true },
    address:               { type: String, trim: true },
    services:              { type: [serviceLineSchema], default: [] },
    parts:                 { type: [partLineSchema], default: [] },
    partsAmount:           { type: Number, default: 0 },
    discount:              { type: Number, default: 0 },
    gstPercentage:         { type: Number, default: 0 },
    servicesAmount:        { type: Number, default: 0 },
    servicesAmountWithTax: { type: Number, default: 0 },
    dueDate:               { type: Date },
    paid:                  { type: Boolean, default: false },
    status: {
      type:    String,
      enum:    ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
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
  this.numId     = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.invoiceId = `${pfx}-INV-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, customerId: 1 });

export const NativeInvoice = mongoose.model<IInvoiceDoc>(
  'NativeInvoice',
  schema,
  'native_invoices'
);

