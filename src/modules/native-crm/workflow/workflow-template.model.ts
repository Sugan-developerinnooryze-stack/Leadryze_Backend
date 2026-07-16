import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IWorkflowStep {
  docType: 'quotation' | 'contract' | 'workorder' | 'invoice';
  label:   string;
  order:   number;
  color:   string;
}

export interface IWorkflowTemplateDoc extends Document {
  tenantId:  mongoose.Types.ObjectId;
  clientId?: string;
  name:      string;
  isDefault: boolean;
  steps:     IWorkflowStep[];
  createdAt: Date;
  updatedAt: Date;
}

const stepSchema = new Schema<IWorkflowStep>(
  {
    docType: { type: String, enum: ['quotation', 'contract', 'workorder', 'invoice'], required: true },
    label:   { type: String, required: true, trim: true },
    order:   { type: Number, required: true },
    color:   { type: String, default: 'blue' },
  },
  { _id: false }
);

const schema = new Schema<IWorkflowTemplateDoc>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:  { type: String, index: true },
    name:      { type: String, required: true, trim: true },
    isDefault: { type: Boolean, default: false },
    steps:     { type: [stepSchema], default: [] },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, isDefault: 1 });

export const WorkflowTemplate = mongoose.model<IWorkflowTemplateDoc>(
  'WorkflowTemplate',
  schema,
  'native_workflow_templates'
);
