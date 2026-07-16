import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IExpenseDoc extends Document {
  tenantId:     mongoose.Types.ObjectId;
  branchId?:    mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:        number;
  expenseId:    string;
  title:        string;
  category?:    string;
  amount:       number;
  date?:        Date;
  paidBy?:      string;
  workOrderId?: string;
  notes?:       string;
  status:       'pending' | 'approved' | 'rejected';
  customFields?: Record<string, any>;
  createdBy?:   string;
  createdAt:    Date;
  updatedAt:    Date;
}

const schema = new Schema<IExpenseDoc>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:     { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:        { type: Number },
    expenseId:    { type: String },
    title:        { type: String, required: true, trim: true },
    category:     { type: String, trim: true },
    amount:       { type: Number, required: true, min: 0 },
    date:         { type: Date },
    paidBy:       { type: String, trim: true },
    workOrderId:  { type: String, trim: true },
    notes:        { type: String },
    status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:    { type: String },
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
  this.expenseId = `${pfx}-EXP-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });

export const NativeExpense = mongoose.model<IExpenseDoc>(
  'NativeExpense',
  schema,
  'native_expenses'
);

