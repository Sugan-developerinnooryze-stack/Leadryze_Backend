import mongoose, { Schema, Document } from 'mongoose';

export interface IQnAPair extends Document {
  tenantId: mongoose.Types.ObjectId;
  question: string;
  answer: string;
  category: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const qnaSchema = new Schema<IQnAPair>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    question: { type: String, required: true, trim: true },
    answer:   { type: String, required: true, trim: true },
    category: { type: String, default: 'general' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const QnAPair = mongoose.model<IQnAPair>('QnAPair', qnaSchema);
