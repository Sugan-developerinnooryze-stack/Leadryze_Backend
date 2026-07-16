import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IFormField {
  key:          string;
  label:        string;
  fieldType:    'text' | 'number' | 'currency' | 'date' | 'email' | 'phone'
              | 'textarea' | 'dropdown' | 'image' | 'images' | 'formula'
              | 'radio' | 'multi_select' | 'boolean' | 'rating' | 'url' | 'time' | 'datetime'
              | 'cascade_dropdown' | 'table';
  options?:     string[];
  parentKey?:   string;
  parentValues?: string[];
  formula?:     string;
  required?:    boolean;
  order:        number;
}

export interface ICustomFormTemplateDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  clientId?:   string;
  name:        string;
  description?: string;
  fields:      IFormField[];
  createdAt:   Date;
  updatedAt:   Date;
}

const formFieldSchema = new Schema<IFormField>(
  {
    key:          { type: String, required: true, trim: true },
    label:        { type: String, required: true, trim: true },
    fieldType:    {
      type: String,
      enum: ['text','number','currency','date','email','phone','textarea','dropdown','image','images','formula',
             'radio','multi_select','boolean','rating','url','time','datetime','cascade_dropdown','table'],
      required: true,
    },
    options:      [{ type: String }],
    parentKey:    { type: String },
    parentValues: [{ type: String }],
    formula:      { type: String },
    required:     { type: Boolean, default: false },
    order:        { type: Number, default: 0 },
  },
  { _id: false }
);

const schema = new Schema<ICustomFormTemplateDoc>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:    { type: String, index: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    fields:      [formFieldSchema],
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, name: 1 });

export const NativeCustomFormTemplate = mongoose.model<ICustomFormTemplateDoc>(
  'NativeCustomFormTemplate',
  schema,
  'native_custom_form_templates'
);
