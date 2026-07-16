import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export type CustomFieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'checkbox'
  | 'radio' | 'dropdown' | 'multi_select' | 'date' | 'datetime'
  | 'email' | 'phone' | 'url' | 'rating' | 'boolean'
  | 'image' | 'images' | 'video' | 'videos' | 'custom_form';

export interface ICustomFieldDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  clientId?:      string;
  module:         string;
  fieldKey:       string;
  label:          string;
  fieldType:      CustomFieldType;
  options?:       string[];
  formTemplateId?: string;
  required:       boolean;
  order:          number;
  isActive:       boolean;
  createdBy?:     string;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<ICustomFieldDoc>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:  { type: String, index: true },
    module:    { type: String, required: true, trim: true },
    fieldKey:  { type: String, required: true, trim: true },
    label:     { type: String, required: true, trim: true },
    fieldType: {
      type: String,
      enum: ['text','textarea','number','currency','checkbox','radio','dropdown',
             'multi_select','date','datetime','email','phone','url','rating','boolean',
             'image','images','video','videos','custom_form'],
      required: true,
    },
    options:        [{ type: String }],
    formTemplateId: { type: String },
    required:       { type: Boolean, default: false },
    order:     { type: Number, default: 0 },
    isActive:  { type: Boolean, default: true },
    createdBy: { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, module: 1 });
schema.index({ tenantId: 1, module: 1, fieldKey: 1 }, { unique: true });

export const NativeCustomField = mongoose.model<ICustomFieldDoc>(
  'NativeCustomField',
  schema,
  'native_custom_fields'
);
