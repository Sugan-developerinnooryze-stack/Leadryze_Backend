import mongoose, { Schema, Document } from 'mongoose';

/**
 * One persistent record per distinct knowledge source a tenant has (their
 * website, an uploaded catalog file) — re-syncing the SAME source updates
 * this same doc rather than creating a new row per run. Gives every
 * ProductCatalogItem traceability back to what produced it, and gives
 * admins a simple "is this source healthy" status without digging through
 * logs.
 */
export interface IKnowledgeSource extends Document {
  tenantId: mongoose.Types.ObjectId;
  type: 'website' | 'excel' | 'csv' | 'json';
  label: string; // the crawled URL, or the uploaded filename
  status: 'pending' | 'running' | 'completed' | 'failed';
  lastSyncAt?: Date;
  lastSyncDurationMs?: number;
  itemsImported: number;
  itemsUpdated: number;
  itemsFailed: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const knowledgeSourceSchema = new Schema<IKnowledgeSource>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    type: { type: String, enum: ['website', 'excel', 'csv', 'json'], required: true },
    label: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending' },
    lastSyncAt: Date,
    lastSyncDurationMs: Number,
    itemsImported: { type: Number, default: 0 },
    itemsUpdated: { type: Number, default: 0 },
    itemsFailed: { type: Number, default: 0 },
    lastError: String,
  },
  { timestamps: true }
);

knowledgeSourceSchema.index({ tenantId: 1, type: 1 });
knowledgeSourceSchema.index({ tenantId: 1, type: 1, label: 1 }, { unique: true });

export const KnowledgeSource = mongoose.model<IKnowledgeSource>(
  'KnowledgeSource',
  knowledgeSourceSchema,
  'native_knowledge_sources'
);
