import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export type CustomFieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'checkbox'
  | 'radio' | 'dropdown' | 'multi_select' | 'date' | 'datetime'
  | 'email' | 'phone' | 'url' | 'rating' | 'boolean'
  | 'image' | 'images' | 'video' | 'videos' | 'custom_form';

export interface ICustomFieldDoc extends Document {
  tenantId:       mongoose.Types.ObjectId;
  branchId?:      mongoose.Types.ObjectId | null;
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
    branchId:  { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
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

schema.index({ tenantId: 1, branchId: 1, module: 1 });
// Real, confirmed bug this fixes: this model had no branchId at all, so
// every custom field was tenant-wide regardless of which branch it was
// created under — a field made while "CBE Branch" was selected showed up
// under every other branch too. branchId now included in the unique key so
// the same fieldKey can exist independently per branch, matching every
// other branch-scoped native-crm model's own {tenantId,branchId,...}
// convention. Pre-existing fields (no branchId in the stored document) still
// match branchId:null queries — Mongo treats "missing" and "null" as
// equivalent for this comparison — so no data migration is needed.
schema.index({ tenantId: 1, branchId: 1, module: 1, fieldKey: 1 }, { unique: true });

export const NativeCustomField = mongoose.model<ICustomFieldDoc>(
  'NativeCustomField',
  schema,
  'native_custom_fields'
);
