import mongoose, { Schema, Document } from 'mongoose';

export type TriageStatus = 'pending' | 'created' | 'skipped';

export interface ILeadImportTriage extends Document {
  tenantId:       mongoose.Types.ObjectId;
  batchId:        string;
  /** The original parsed CSV row, kept verbatim so "Create as new lead" can
   * replay it exactly and "Skip" has full context for the admin reviewing it. */
  rawRow:         Record<string, any>;
  /** Why this row wasn't auto-created — v1 only ever produces 'domain' (same
   * email domain as an existing lead, but not an exact match). */
  matchType:      'domain';
  matchedLeadIds: string[];
  status:         TriageStatus;
  resolvedAt?:    Date;
  resolvedBy?:    string;
  createdAt:      Date;
  updatedAt:      Date;
}

const schema = new Schema<ILeadImportTriage>(
  {
    tenantId:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    batchId:        { type: String, required: true, index: true },
    rawRow:         { type: Schema.Types.Mixed, required: true },
    matchType:      { type: String, enum: ['domain'], default: 'domain' },
    matchedLeadIds: [{ type: String }],
    status:         { type: String, enum: ['pending', 'created', 'skipped'], default: 'pending' },
    resolvedAt:     { type: Date },
    resolvedBy:     { type: String },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, batchId: 1 });

export const LeadImportTriage = mongoose.model<ILeadImportTriage>(
  'LeadImportTriage',
  schema,
  'native_lead_import_triage',
);
