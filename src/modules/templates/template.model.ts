import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplate extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  type: 'email' | 'whatsapp' | 'sms';
  category: 'followup' | 'booking' | 'reminder' | 'marketing' | 'onboarding' | 'feedback';
  subject?: string;
  body: string;
  variables: string[];
  language: string;
  isActive: boolean;
  aiGenerated: boolean;
  whatsappTemplateName?: string;
  whatsappTemplateStatus?: 'pending' | 'approved' | 'rejected';
}

const templateSchema = new Schema<ITemplate>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['email', 'whatsapp', 'sms'], required: true },
    category: {
      type: String,
      enum: ['followup', 'booking', 'reminder', 'marketing', 'onboarding', 'feedback', 'appointment', 'meeting', 'task', 'custom'],
      required: true,
    },
    subject: String,
    body: { type: String, required: true },
    variables: { type: [String], default: [] },
    language: { type: String, default: 'en' },
    isActive: { type: Boolean, default: true },
    aiGenerated: { type: Boolean, default: false },
    whatsappTemplateName: String,
    whatsappTemplateStatus: { type: String, enum: ['pending', 'approved', 'rejected'] },
  },
  { timestamps: true }
);

templateSchema.index({ tenantId: 1, type: 1, category: 1 });

export const Template = mongoose.model<ITemplate>('Template', templateSchema);
