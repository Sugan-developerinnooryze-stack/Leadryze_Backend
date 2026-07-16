import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../utils/client-id';

export type CustomModuleFieldType =
  | 'text' | 'email' | 'phone' | 'number' | 'currency'
  | 'date' | 'datetime' | 'textarea' | 'boolean' | 'url' | 'rating'
  | 'select' | 'multiselect' | 'relationship'
  | 'image' | 'images'
  | 'categoryselect';

export interface ICustomModuleField {
  key:        string;
  label:      string;
  fieldType:  CustomModuleFieldType;
  required?:  boolean;
  options?:   string[];
  meta?: {
    targetModule?:     string;
    lookupLabelField?: string;
    lookupValueField?: string;
    cascadeTree?:      unknown;
    levelNames?:       string[];
    subFields?:        string[];
  };
  order: number;
}

export interface ICustomModuleDef extends Document {
  tenantId:     mongoose.Types.ObjectId;
  clientId?:    string;
  slug:         string;
  name:         string;
  singularName: string;
  icon:         string;
  color:        string;
  showInSidebar: boolean;
  menuOrder:    number;
  fields:       ICustomModuleField[];
  createdAt:    Date;
  updatedAt:    Date;
}

const CustomModuleFieldSchema = new Schema<ICustomModuleField>(
  {
    key:       { type: String, required: true, trim: true },
    label:     { type: String, required: true, trim: true },
    fieldType: {
      type: String,
      enum: ['text','email','phone','number','currency','date','datetime','textarea','boolean','url','rating','select','multiselect','relationship','image','images','categoryselect'],
      required: true,
    },
    required: { type: Boolean, default: false },
    options:  [{ type: String }],
    meta: {
      targetModule:     { type: String },
      lookupLabelField: { type: String },
      lookupValueField: { type: String },
      cascadeTree:      { type: Schema.Types.Mixed },
      levelNames:       [{ type: String }],
      subFields:        [{ type: String }],
    },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const CustomModuleDefSchema = new Schema<ICustomModuleDef>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:     { type: String, index: true },
    slug:         { type: String, required: true, trim: true, lowercase: true },
    name:         { type: String, required: true, trim: true },
    singularName: { type: String, required: true, trim: true },
    icon:         { type: String, default: '📋' },
    color:        { type: String, default: '#6366f1' },
    showInSidebar: { type: Boolean, default: true },
    menuOrder:    { type: Number, default: 0 },
    fields:       [CustomModuleFieldSchema],
  },
  { timestamps: true }
);

CustomModuleDefSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

CustomModuleDefSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
CustomModuleDefSchema.index({ tenantId: 1, menuOrder: 1 });

export const CustomModuleDef = mongoose.model<ICustomModuleDef>(
  'CustomModuleDef',
  CustomModuleDefSchema,
  'native_custom_module_defs'
);

/* ── Custom Records ───────────────────────────────────────────────────────── */

export interface ICustomRecord extends Document {
  tenantId:   mongoose.Types.ObjectId;
  clientId?:  string;
  moduleSlug: string;
  numId:      number;
  recordId:   string;
  data:       Record<string, unknown>;
  createdBy?: string;
  createdAt:  Date;
  updatedAt:  Date;
}

const CustomRecordSchema = new Schema<ICustomRecord>(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:   { type: String, index: true },
    moduleSlug: { type: String, required: true, trim: true },
    numId:      { type: Number, default: 0 },
    recordId:   { type: String },
    data:       { type: Schema.Types.Mixed, default: {} },
    createdBy:  { type: String },
  },
  { timestamps: true }
);

CustomRecordSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

CustomRecordSchema.index({ tenantId: 1, moduleSlug: 1 });
CustomRecordSchema.index({ tenantId: 1, moduleSlug: 1, createdAt: -1 });

export const CustomRecord = mongoose.model<ICustomRecord>(
  'CustomRecord',
  CustomRecordSchema,
  'native_custom_records'
);
