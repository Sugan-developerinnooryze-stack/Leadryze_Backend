import mongoose, { Schema, Document } from 'mongoose';

export type BuiltInPipelineModule = 'lead' | 'deal' | 'task' | 'ticket' | 'quotation' | 'workorder' | 'contract' | 'invoice';
/** Tenant-built Custom Modules (native-crm/custom-modules) share this same
 * pipeline/automation infrastructure via a `custom:<slug>` module value —
 * unlike the 8 built-ins, there's no fixed list to enumerate, hence the
 * template-literal escape hatch alongside the closed built-in union. */
export type PipelineModule = BuiltInPipelineModule | `custom:${string}`;

export interface IPipelineStage {
  key:        string;
  label:      string;
  color:      string;
  order:      number;
  isTerminal: boolean;
  /** A free-form semantic tag identifying what this stage MEANS to code that
   * needs to find it regardless of its current key/label — e.g. 'won'/'lost'
   * for Lead/Deal, 'approved' for Quotation, 'completed'/'cancelled' for
   * WorkOrder, 'active' for Contract, 'paid' for Invoice. Business logic
   * (auto-lock triggers, the contract auto-generation cron, etc.) resolves
   * the tenant's current key for a tag via getOutcomeStageKey() instead of
   * comparing against a hardcoded literal, so renaming a stage can never
   * silently break that logic. */
  outcome:    string | null;
  isActive:   boolean;
}

export interface IPipelineConfig extends Document {
  tenantId:  mongoose.Types.ObjectId;
  module:    PipelineModule;
  stages:    IPipelineStage[];
  createdAt: Date;
  updatedAt: Date;
}

const stageSchema = new Schema<IPipelineStage>(
  {
    key:        { type: String, required: true, trim: true },
    label:      { type: String, required: true, trim: true },
    color:      { type: String, default: '#6366f1' },
    order:      { type: Number, default: 0 },
    isTerminal: { type: Boolean, default: false },
    outcome:    { type: String, default: null },
    isActive:   { type: Boolean, default: true },
  },
  { _id: false }
);

const schema = new Schema<IPipelineConfig>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    module:   { type: String, required: true, trim: true },
    stages:   { type: [stageSchema], default: [] },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, module: 1 }, { unique: true });

export const PipelineConfig = mongoose.model<IPipelineConfig>(
  'PipelineConfig',
  schema,
  'native_pipeline_configs'
);
