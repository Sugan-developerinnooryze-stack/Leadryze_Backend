import mongoose, { Schema, Document } from 'mongoose';

/**
 * One row of a tenant-uploaded dataset — records live individually here,
 * never as one giant JSON blob per dataset (deliberate: lets MongoDB do
 * real per-record filtering/indexing/pagination instead of the AI ever
 * reading a whole file's worth of rows at once).
 *
 * `data` keeps every original column value under its own original column
 * name — nothing is ever destroyed or renamed away. `normalized` is a
 * SEPARATE, PARALLEL bag keyed by semantic ROLE (not by column name) —
 * e.g. `normalized.price`, `normalized.location` — specifically so this
 * schema can carry a small, fixed, bounded set of real Mongo indexes
 * (see the index list below) regardless of how many/which columns any
 * given tenant's file happens to have. If two columns in the same dataset
 * both map to the same role (e.g. "List Price" and "Discounted Price"),
 * only the higher-confidence one is promoted into `normalized.price`; the
 * other stays a plain field in `data` — a documented V1 simplification,
 * not silently lossy (both stay in `data` regardless).
 *
 * `sourceName`/`sheetName` are populated with a single fixed value in V1
 * (the uploaded filename / the one sheet read) — present now so V2's
 * multi-sheet support is a value change, not a schema migration.
 */
export interface IDatasetRecord extends Document {
  tenantId: mongoose.Types.ObjectId;
  datasetId: mongoose.Types.ObjectId;
  datasetVersion: number;
  /** Stable within a version — the source row number when no better
   * identifier column exists. Combined with tenantId/datasetId/
   * datasetVersion, this is the idempotent Mongo upsert key; the Qdrant
   * side derives its own point id as a deterministic UUID v5 of
   * `${tenantId}:${datasetId}:${datasetVersion}:${recordId}` (see
   * ai/src/rag/dataset-index.service.ts) — Qdrant point ids must be a real
   * UUID or uint64, never an arbitrary string, so the two idempotency
   * mechanisms are related but not literally the same value. Either way,
   * re-running an interrupted ingestion batch never duplicates a record or
   * a vector. */
  recordId: string;
  sourceName: string;
  sheetName: string;
  rowNumber: number;
  /** Cross-version row identity for diff reporting (Part B) — priority
   * order computed once in buildRecordFields(): (a) the identifier-role
   * column's value if mapped and non-empty, (b) a normalized name+category
   * composite if both are mapped, (c) null when neither is available. A
   * null identityKey is never matched across versions — an ambiguous row
   * is always counted as added (new version) / removed (old version), per
   * decision in the plan, rather than silently guessed at. */
  identityKey: string | null;
  data: Record<string, unknown>;
  normalized: {
    name?: string;
    category?: string;
    price?: number;
    location?: string;
    date?: string;
    description?: string;
    identifier?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const datasetRecordSchema = new Schema<IDatasetRecord>(
  {
    tenantId:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    datasetId:      { type: Schema.Types.ObjectId, ref: 'Dataset', required: true },
    datasetVersion: { type: Number, required: true },
    recordId:       { type: String, required: true },
    sourceName:     { type: String, required: true },
    sheetName:      { type: String, required: true },
    rowNumber:      { type: Number, required: true },
    identityKey:    { type: String, default: null },
    data:           { type: Schema.Types.Mixed, default: {} },
    normalized: {
      name:        { type: String },
      category:    { type: String },
      price:       { type: Number },
      location:    { type: String },
      date:        { type: String },
      description: { type: String },
      identifier:  { type: String },
    },
  },
  { timestamps: true }
);

// Idempotent-upsert key AND the natural "give me this version's records"
// scope — every ingestion/query touches this shape. tenantId is included
// (hardening Gap 4) even though datasetId alone already determines a
// tenant in practice — keeps this index consistent with every other
// filter in this system, which is always tenant-scoped first.
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, recordId: 1 }, { unique: true });
// Mandatory tenant-scoped compound index (decision #11) — every query the
// safe query executor runs is scoped through this.
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1 });
// Bounded, fixed set of role-keyed indexes — sparse, since most datasets
// won't populate every role, and there are exactly 5 of them regardless of
// how many raw columns a tenant's file has (the actual "don't create one
// index per uploaded column" guarantee).
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, 'normalized.price': 1 }, { sparse: true });
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, 'normalized.date': 1 }, { sparse: true });
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, 'normalized.location': 1 }, { sparse: true });
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, 'normalized.category': 1 }, { sparse: true });
datasetRecordSchema.index({ tenantId: 1, datasetId: 1, datasetVersion: 1, 'normalized.identifier': 1 }, { sparse: true });

export const DatasetRecord = mongoose.model<IDatasetRecord>(
  'DatasetRecord',
  datasetRecordSchema,
  'native_dataset_records'
);
