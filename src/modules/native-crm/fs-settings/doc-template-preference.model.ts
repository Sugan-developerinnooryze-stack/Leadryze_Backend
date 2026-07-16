import mongoose, { Schema, Document } from 'mongoose';

export interface IDocTemplatePreference extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  docType:        'invoice' | 'quotation' | 'contract' | 'workorder';
  defaultVariant: 'classic' | 'modern' | 'minimal';
}

const schema = new Schema<IDocTemplatePreference>(
  {
    tenantId:       { type: Schema.Types.ObjectId, required: true },
    branchId:       { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    docType:        { type: String, enum: ['invoice','quotation','contract','workorder'], required: true },
    defaultVariant: { type: String, enum: ['classic','modern','minimal'], default: 'classic' },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, docType: 1, branchId: 1 }, { unique: true });

export const DocTemplatePreference = mongoose.model<IDocTemplatePreference>(
  'DocTemplatePreference',
  schema,
  'doc_template_preferences'
);
