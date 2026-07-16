import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IReceiptDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:          number;
  receiptId:      string;
  invoiceId:      string;
  customerId:     string;
  amount:         number;
  paymentMethod:  'cash' | 'bank_transfer' | 'card' | 'cheque' | 'online';
  paymentDate?:   Date;
  notes?:         string;
  status:         'pending' | 'completed' | 'refunded';
  customFields?: Record<string, any>;
  createdBy?:     string;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<IReceiptDoc>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:      { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:         { type: Number },
    receiptId:     { type: String },
    invoiceId:     { type: String, required: true, trim: true },
    customerId:    { type: String, required: true, trim: true },
    amount:        { type: Number, required: true, min: 0 },
    paymentMethod: {
      type:    String,
      enum:    ['cash', 'bank_transfer', 'card', 'cheque', 'online'],
      default: 'cash',
    },
    paymentDate: { type: Date },
    notes:       { type: String },
    status: {
      type:    String,
      enum:    ['pending', 'completed', 'refunded'],
      default: 'completed',
    },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: String },
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
  this.receiptId = `${pfx}-RCP-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, invoiceId: 1 });

export const NativeReceipt = mongoose.model<IReceiptDoc>(
  'NativeReceipt',
  schema,
  'native_receipts'
);

