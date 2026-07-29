import mongoose, { Schema, Document } from 'mongoose';

export interface ITemplateSections {
  services: boolean;
  parts:    boolean;
  totals:   boolean;
  notes:    boolean;
  terms:    boolean;
}

export const DEFAULT_TEMPLATE_SECTIONS: ITemplateSections = {
  services: true, parts: true, totals: true, notes: true, terms: true,
};

export interface IDocTemplatePreference extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
  docType:        'invoice' | 'quotation' | 'contract' | 'workorder';
  defaultVariant: 'classic' | 'modern' | 'minimal' | 'elegant';
  sections:       ITemplateSections;
}

const templateSectionsSchema = new Schema<ITemplateSections>(
  {
    services: { type: Boolean, default: true },
    parts:    { type: Boolean, default: true },
    totals:   { type: Boolean, default: true },
    notes:    { type: Boolean, default: true },
    terms:    { type: Boolean, default: true },
  },
  { _id: false }
);

const schema = new Schema<IDocTemplatePreference>(
  {
    tenantId:       { type: Schema.Types.ObjectId, required: true },
    branchId:       { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    docType:        { type: String, enum: ['invoice','quotation','contract','workorder'], required: true },
    defaultVariant: { type: String, enum: ['classic','modern','minimal','elegant'], default: 'classic' },
    sections:       { type: templateSectionsSchema, default: () => ({ ...DEFAULT_TEMPLATE_SECTIONS }) },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, docType: 1, branchId: 1 }, { unique: true });

export const DocTemplatePreference = mongoose.model<IDocTemplatePreference>(
  'DocTemplatePreference',
  schema,
  'doc_template_preferences'
);
