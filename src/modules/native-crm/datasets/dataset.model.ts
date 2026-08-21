import mongoose, { Schema, Document } from 'mongoose';

/**
 * The generic "tenant uploaded some business data" concept — Products,
 * Services, Machines, Courses, anything — alongside (not replacing)
 * `CatalogItem`/`KnowledgeSource` (native-crm/catalog/), which stays the
 * Product-Catalog-specific pipeline. `Dataset` is the logical entity a
 * tenant sees ("Industrial Machines"); the actual searchable content lives
 * in `DatasetVersion`/`DatasetRecord` — a re-upload creates a NEW version,
 * fully imports and indexes it, and only then flips `activeVersion` (see
 * dataset-version.model.ts's own doc comment for why this is atomic).
 */
export interface IDataset extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  sourceFileName: string;
  sourceType: 'excel' | 'csv' | 'json';
  /** Opt-in, default false — matches the existing opt-in posture of every
   * other public-widget-facing feature in this codebase (e.g. Website
   * Content/Product Catalog are configured before they affect the widget).
   * A tenant must explicitly enable a dataset before the public chatbot can
   * search it, checked server-side on every query (never trusted from the
   * LLM or the query plan). */
  availableToChatbot: boolean;
  /** Which DatasetVersion.version is currently live — undefined until the
   * first import completes successfully. Only ever set by the ingestion
   * pipeline finishing a version as `ready`/`ready_with_warnings`, never
   * directly by a client request. */
  activeVersion?: number;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const datasetSchema = new Schema<IDataset>(
  {
    tenantId:           { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name:                { type: String, required: true, trim: true },
    sourceFileName:      { type: String, required: true, trim: true },
    sourceType:          { type: String, enum: ['excel', 'csv', 'json'], required: true },
    availableToChatbot:  { type: Boolean, default: false },
    activeVersion:       { type: Number },
    createdBy:           { type: String },
  },
  { timestamps: true }
);

datasetSchema.index({ tenantId: 1 });
datasetSchema.index({ tenantId: 1, availableToChatbot: 1 });

export const Dataset = mongoose.model<IDataset>(
  'Dataset',
  datasetSchema,
  'native_datasets'
);
