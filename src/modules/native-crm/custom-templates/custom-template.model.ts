import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IDesignElement {
  id:              string;
  type:            'text' | 'image' | 'table' | 'divider' | 'box';
  x:               number;
  y:               number;
  w:               number;
  h:               number;
  content?:        string;
  fontSize?:       number;
  fontWeight?:     'normal' | 'bold';
  fontStyle?:      'normal' | 'italic';
  color?:          string;
  textAlign?:      'left' | 'center' | 'right';
  src?:            string;
  backgroundColor?: string;
  borderColor?:    string;
  borderWidth?:    number;
}

export interface ICustomTemplate extends Document {
  tenantId:   mongoose.Types.ObjectId;
  clientId?:  string;
  docType:    'invoice' | 'quotation' | 'contract' | 'workorder';
  name:       string;
  isDefault:  boolean;
  elements:   IDesignElement[];
}

const elementSchema = new Schema<IDesignElement>(
  {
    id:              { type: String, required: true },
    type:            { type: String, enum: ['text','image','table','divider','box'], required: true },
    x:               { type: Number, required: true },
    y:               { type: Number, required: true },
    w:               { type: Number, required: true },
    h:               { type: Number, required: true },
    content:         String,
    fontSize:        Number,
    fontWeight:      String,
    fontStyle:       String,
    color:           String,
    textAlign:       String,
    src:             String,
    backgroundColor: String,
    borderColor:     String,
    borderWidth:     Number,
  },
  { _id: false }
);

const schema = new Schema<ICustomTemplate>(
  {
    tenantId:  { type: Schema.Types.ObjectId, required: true },
    clientId:  { type: String, index: true },
    docType:   { type: String, enum: ['invoice','quotation','contract','workorder'], required: true },
    name:      { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    elements:  { type: [elementSchema], default: [] },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, docType: 1 });

export const CustomTemplate = mongoose.model<ICustomTemplate>(
  'CustomTemplate',
  schema,
  'custom_templates'
);
