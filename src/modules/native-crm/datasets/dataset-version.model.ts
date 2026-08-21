import mongoose, { Schema, Document } from 'mongoose';

/**
 * One import attempt for a `Dataset` — a re-upload creates a NEW version
 * rather than mutating the previous one, imports fully into MongoDB
 * (DatasetRecord) and Qdrant, and only then does `Dataset.activeVersion`
 * flip to point at it (atomically/monotonically — see dataset.service.ts's
 * finalizeVersion()). Mongo and Qdrant can't share one transaction, so this
 * document tracks live progress (`recordsInserted`/`vectorsIndexed`) and
 * both writes downstream are themselves idempotent (DatasetRecord upserts
 * on {tenantId, datasetId, datasetVersion, recordId}; Qdrant point ids are
 * a deterministic UUID v5 of that same identity — see
 * ai/src/rag/dataset-index.service.ts) so a re-run never duplicates data.
 * `rawRows` makes this idempotency actually useful after a process crash,
 * not just a retried batch within one still-running process — see its own
 * field comment and dataset.service.ts's startup recovery pass.
 *
 * A version that never reaches `ready`/`ready_with_warnings` is cleaned up
 * (its DatasetRecords + Qdrant vectors deleted) rather than left as
 * permanent orphaned data — see dataset.service.ts's finalization step.
 */
export type DatasetVersionStatus =
  | 'analyzing' | 'ready_for_review' | 'importing' | 'indexing'
  | 'ready' | 'ready_with_warnings' | 'failed';

// 'image' expects the column's VALUE to be an http(s):// URL string — a
// display-only role (no dataType/index of its own, no filter/sort support),
// looked up via data.<normalizedName> at tool-execution time (search-dataset
// tool). No support for a picture embedded/anchored inside an Excel cell (a
// real capability gap, not a filtering choice — that data never reaches the
// row-parsing layer at all); Image URL columns only, V1.
export type SemanticRole = 'name' | 'category' | 'price' | 'location' | 'date' | 'description' | 'identifier' | 'image';
export type DatasetColumnType = 'string' | 'number' | 'currency' | 'date' | 'boolean';

export interface IDatasetColumn {
  originalName: string;
  /** Same snake_case convention as catalog-item.service.ts's
   * normalizeSpecKey — used for the `data` bag's own keys. */
  normalizedName: string;
  /** Present only for the (at most) one column per role that gets promoted
   * to a first-class, indexed `DatasetRecord.normalized.<role>` field — see
   * dataset-record.model.ts's own comment on why role, not column name, is
   * the indexed key. Every other column (unmapped, or a second column that
   * would collide with an already-claimed role) stays a plain field. */
  semanticRole?: SemanticRole;
  /** 0-1. Below the confidence threshold (0.6) the column is treated as
   * unmapped for indexing purposes but is NEVER excluded from import —
   * still stored and searchable, just without a first-class role. */
  confidence: number;
  source: 'heuristic' | 'manual';
  dataType: DatasetColumnType;
}

export interface IDatasetVersion extends Document {
  tenantId: mongoose.Types.ObjectId;
  datasetId: mongoose.Types.ObjectId;
  /** 1, 2, 3... increasing per dataset — the value `Dataset.activeVersion`
   * points at once this version is ready. */
  version: number;
  status: DatasetVersionStatus;
  /** Named `columns`, not `schema` — `schema` collides with Mongoose
   * Document's own reserved `.schema` property (the doc's own Mongoose
   * schema definition), which TypeScript correctly rejects. */
  columns: IDatasetColumn[];
  headerRowIndex: number;
  /** Rows detected in the confirmed preview — compared against actual
   * recordsInserted/vectorsIndexed to decide ready vs ready_with_warnings
   * vs failed at finalization. */
  expectedRecordCount: number;
  recordsInserted: number;
  recordsFailed: number;
  vectorsIndexed: number;
  vectorsFailed: number;
  /** Individual cell values over MAX_CELL_LENGTH that got truncated rather
   * than rejected (hardening Gap 8) — surfaced in the import result so a
   * truncation is a visible warning, never silent. */
  cellsTruncated: number;
  /** Dataset image-import feature (Excel + ZIP mode) — real per-row image
   * outcomes, surfaced the same way cellsTruncated already is: a missing or
   * invalid image is a visible warning on an otherwise-successful import,
   * never a silent gap or a reason to fail the whole thing. All 0 for a
   * dataset with no `image`-role column, or Mode A (URL column, no ZIP)
   * where there's nothing to "find" — the URL is either valid or it isn't. */
  imagesFound?: number;
  imagesMissing?: number;
  imagesInvalid?: number;
  /** Diff summary (Part B) against the previous ACTIVE version at the time
   * this version activated — computed once in finalizeVersion() by
   * comparing DatasetRecord.identityKey + a content hash of `data` across
   * both versions. Only meaningful once status is terminal and non-failed;
   * 0/0/0/0 for a version's very first upload into a dataset (nothing to
   * diff against) or before finalization runs. */
  diffAdded: number;
  diffUpdated: number;
  diffRemoved: number;
  diffUnchanged: number;
  /** The confirmed rows this version was built from, persisted so a
   * crashed/restarted backend can safely resume this import from scratch
   * via the same idempotent pipeline (hardening Gap 2) — the async import
   * (Gap 8) responds to the HTTP request before the pipeline finishes, so
   * without a durable copy of the rows a process crash mid-pipeline would
   * leave this version permanently stuck. Cleared once status reaches any
   * terminal value (ready/ready_with_warnings/failed) — this is working
   * storage for a pending job, not a permanent copy of the upload. */
  rawRows?: Record<string, unknown>[];
  lastError?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const datasetColumnSchema = new Schema<IDatasetColumn>(
  {
    originalName:   { type: String, required: true },
    normalizedName: { type: String, required: true },
    semanticRole:   { type: String, enum: ['name', 'category', 'price', 'location', 'date', 'description', 'identifier', 'image'] },
    confidence:     { type: Number, required: true, default: 0 },
    source:         { type: String, enum: ['heuristic', 'manual'], default: 'heuristic' },
    dataType:       { type: String, enum: ['string', 'number', 'currency', 'date', 'boolean'], default: 'string' },
  },
  { _id: false }
);

const datasetVersionSchema = new Schema<IDatasetVersion>(
  {
    tenantId:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    datasetId: { type: Schema.Types.ObjectId, ref: 'Dataset', required: true },
    version:   { type: Number, required: true },
    status: {
      type: String,
      enum: ['analyzing', 'ready_for_review', 'importing', 'indexing', 'ready', 'ready_with_warnings', 'failed'],
      default: 'analyzing',
    },
    columns:             { type: [datasetColumnSchema], default: [] },
    headerRowIndex:      { type: Number, default: 0 },
    expectedRecordCount: { type: Number, default: 0 },
    recordsInserted:     { type: Number, default: 0 },
    recordsFailed:       { type: Number, default: 0 },
    vectorsIndexed:      { type: Number, default: 0 },
    vectorsFailed:       { type: Number, default: 0 },
    cellsTruncated:      { type: Number, default: 0 },
    imagesFound:         { type: Number, default: 0 },
    imagesMissing:       { type: Number, default: 0 },
    imagesInvalid:       { type: Number, default: 0 },
    diffAdded:           { type: Number, default: 0 },
    diffUpdated:         { type: Number, default: 0 },
    diffRemoved:         { type: Number, default: 0 },
    diffUnchanged:       { type: Number, default: 0 },
    rawRows:             { type: [Schema.Types.Mixed], select: false },
    lastError:           { type: String },
    startedAt:           { type: Date },
    finishedAt:          { type: Date },
    createdBy:           { type: String },
  },
  { timestamps: true }
);

datasetVersionSchema.index({ tenantId: 1, datasetId: 1, version: 1 }, { unique: true });
datasetVersionSchema.index({ tenantId: 1, datasetId: 1, status: 1 });

export const DatasetVersion = mongoose.model<IDatasetVersion>(
  'DatasetVersion',
  datasetVersionSchema,
  'native_dataset_versions'
);
