import mongoose, { Schema, Document } from 'mongoose';
import { IFlowNode, IFlowEdge, flowNodeSchema, flowEdgeSchema } from '../automation-flows/automation-flow.model';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';

/** Starter flow scaffolds ("Phase 4 Templates") — deliberately a separate
 * collection from both automation engines and from the unrelated
 * MessageTemplate concept (email/SMS/WhatsApp body content). A template is
 * never itself a trusted, executable flow — it only ever seeds the *local,
 * unsaved* builder canvas (see automation-template.service.ts's own doc
 * comment); the tenant still explicitly Saves/Publishes through the
 * completely unmodified createFlow/publishFlow path, which reruns every
 * structural validator regardless of where the canvas content came from.
 *
 * `tenantId: null` = a system template (one of the 5 seeded starters,
 * visible to every tenant, never editable/deletable by one). A real
 * ObjectId = a tenant's own "saved as template" flow, visible and
 * deletable only within that tenant. */
export interface IAutomationTemplate extends Document {
  tenantId: mongoose.Types.ObjectId | null;
  name: string;
  description?: string;
  category?: string;
  triggerModule?: PipelineModule;
  nodes: IFlowNode[];
  edges: IFlowEdge[];
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAutomationTemplate>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    name:          { type: String, required: true, trim: true },
    description:   { type: String, trim: true },
    category:      { type: String, trim: true },
    triggerModule: { type: String, trim: true },
    nodes:         { type: [flowNodeSchema], default: [] },
    edges:         { type: [flowEdgeSchema], default: [] },
    createdBy:     { type: String },
  },
  { timestamps: true },
);

// Every list/read is scoped to {tenantId:null} OR {tenantId:<this tenant>} —
// this compound index serves both halves of that $or directly.
schema.index({ tenantId: 1, createdAt: -1 });

export const AutomationTemplate = mongoose.model<IAutomationTemplate>(
  'AutomationTemplate',
  schema,
  'native_automation_templates',
);
