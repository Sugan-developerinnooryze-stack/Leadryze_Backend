import mongoose from 'mongoose';
import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { Dataset } from './dataset.model';
import { DatasetVersion, IDatasetColumn, DatasetVersionStatus } from './dataset-version.model';
import { DatasetRecord } from './dataset-record.model';
import { analyzeColumns } from './dataset-schema.service';
import { buildRecordFields, buildSemanticText } from './dataset-value.service';
import { processDatasetImages } from './dataset-image.service';

const MONGO_BATCH_SIZE = 200;
const QDRANT_BATCH_SIZE = 50;

/** Milestone 3/4 support — the preview endpoint calls this with just the
 * headers + a small sample of rows (not the whole file) so the tenant can
 * see and correct the detected mapping before anything is imported. */
export function analyzeDatasetColumns(headers: string[], sampleRows: Record<string, unknown>[]): IDatasetColumn[] {
  return analyzeColumns(headers, sampleRows);
}

export interface StartImportInput {
  /** Omit to create a brand-new Dataset; provide to re-upload into an
   * existing one as a new version (decision #3). */
  datasetId?: string;
  name: string;
  sourceFileName: string;
  sourceType: 'excel' | 'csv' | 'json';
  /** The confirmed column mapping from the preview step — may include
   * tenant overrides (source:'manual'), not just the heuristic's own
   * guesses. */
  columns: IDatasetColumn[];
  headerRowIndex: number;
  rows: Record<string, unknown>[];
  createdBy?: string;
  /** Real prior upload of a ZIP of product images (dataset-image import
   * feature) — see dataset.controller.ts's uploadImageZip(). Optional; a
   * dataset with no `image`-role column, or Mode A (URL column only), never
   * sets this. */
  imageZipRef?: string;
}

/** Creates (or re-versions) a Dataset, persists the confirmed rows, and
 * returns as soon as that's done — the actual ingestion pipeline (Mongo
 * bulk-write → Qdrant batch indexing → finalize) runs AFTER this function
 * returns, unawaited (hardening Gap 8). This mirrors ingestWebsite()'s own
 * fire-and-forget shape (ai/src/api/knowledge.routes.ts's `POST
 * /knowledge/crawl`) rather than the old synchronous-in-one-request design
 * — a large import doing real per-batch embedding calls can run well past
 * nginx's own 120s proxy_read_timeout, which would otherwise kill the
 * request after the work had already started. The caller (dataset.
 * controller.ts) responds to the HTTP request immediately with this
 * function's return value; the frontend polls `GET /datasets/:id/versions`
 * for live progress. `input.rows` is persisted onto the DatasetVersion
 * (`rawRows`) specifically so a backend crash/restart mid-pipeline can be
 * recovered from — see recoverStuckImports() below (hardening Gap 2). */
export async function startImport(tenantId: string, input: StartImportInput): Promise<{ datasetId: string; version: number }> {
  const tid = new mongoose.Types.ObjectId(tenantId);

  let dataset = input.datasetId ? await Dataset.findOne({ _id: input.datasetId, tenantId: tid }) : null;
  if (!dataset) {
    dataset = await Dataset.create({
      tenantId: tid, name: input.name, sourceFileName: input.sourceFileName, sourceType: input.sourceType,
      createdBy: input.createdBy,
    });
  }

  const prevVersion = await DatasetVersion.findOne({ tenantId: tid, datasetId: dataset._id }).sort({ version: -1 }).lean();
  const version = (prevVersion?.version ?? 0) + 1;

  const datasetVersion = await DatasetVersion.create({
    tenantId: tid, datasetId: dataset._id, version, status: 'importing',
    columns: input.columns, headerRowIndex: input.headerRowIndex,
    expectedRecordCount: input.rows.length, startedAt: new Date(), createdBy: input.createdBy,
    rawRows: input.rows,
  });

  // Deliberately NOT awaited — see this function's own doc comment above.
  runImportPipeline(tenantId, dataset, datasetVersion, input.sourceFileName, input.columns, input.rows, input.imageZipRef).catch((err) => {
    logger.error('Dataset import pipeline crashed outside its own try/catch', { tenantId, datasetId: dataset!._id, version, error: (err as Error).message });
  });

  return { datasetId: String(dataset._id), version };
}

/** The actual ingestion work — split out of startImport() so both the
 * normal (fresh upload) path and recoverStuckImports()'s crash-recovery
 * path (hardening Gap 2) can call the exact same idempotent pipeline.
 * `imageZipRef` is undefined on the crash-recovery path (rawRows doesn't
 * persist it — see recoverStuckImports() below) — a resumed import simply
 * skips image (re-)processing, matching the plan's own disclosed tradeoff
 * that a version without a fresh ZIP carries no new images for itself. */
async function runImportPipeline(
  tenantId: string, dataset: InstanceType<typeof Dataset>, datasetVersion: InstanceType<typeof DatasetVersion>,
  sourceFileName: string, columns: IDatasetColumn[], rows: Record<string, unknown>[], imageZipRef?: string,
): Promise<void> {
  const version = datasetVersion.version;
  try {
    // Runs first and MUTATES rows in place (image-column values become
    // real S3 URLs) — ingestMongoRecords()/ingestQdrantVectors() below then
    // see exactly the same rows a Mode-A (URL-only) import would have, with
    // zero changes needed in either of those two functions for the URL
    // itself. imageMetaByRecordId is threaded through separately into
    // ingestMongoRecords() (see its own comment on why — buildRecordFields()
    // only reads known columns, so the extra metadata can't ride along on
    // the row itself the way the URL does).
    const { imageMetaByRecordId, ...imageCounts } = await processDatasetImages(tenantId, String(dataset._id), version, imageZipRef, columns, rows);
    await DatasetVersion.findByIdAndUpdate(datasetVersion._id, { $set: imageCounts });
    await ingestMongoRecords(tenantId, String(dataset._id), version, sourceFileName, columns, rows, datasetVersion, imageMetaByRecordId);
    await ingestQdrantVectors(tenantId, String(dataset._id), version, columns, rows, datasetVersion);
    await finalizeVersion(tenantId, dataset, datasetVersion);
  } catch (err) {
    logger.error('Dataset import pipeline crashed', { tenantId, datasetId: dataset._id, version, error: (err as Error).message });
    await DatasetVersion.findByIdAndUpdate(datasetVersion._id, {
      $set: { status: 'failed', lastError: (err as Error).message, finishedAt: new Date() },
      $unset: { rawRows: 1 },
    });
    await cleanupFailedVersion(tenantId, String(dataset._id), version);
  }
}

// How long a version can sit at importing/indexing before it's considered
// "the process that was running it is gone," not "still genuinely
// working" (hardening Gap 2) — long enough that a real, still-running
// import on a live process is never falsely reclaimed.
const STUCK_IMPORT_GRACE_MS = 5 * 60 * 1000;

/** Crash/restart recovery (hardening Gap 2) — called once on backend
 * startup (see server.ts). Moving imports to async (above) means the
 * pipeline runs as an unawaited background function inside this process;
 * if the process dies mid-import, that execution simply disappears and the
 * DatasetVersion is left stuck at importing/indexing forever with nothing
 * to notice. This finds any such stuck version whose startedAt is older
 * than the grace period and re-runs the SAME idempotent pipeline from
 * scratch using its persisted `rawRows` — safe specifically because every
 * write in that pipeline is already an upsert (Mongo bulkWrite upsert-by-
 * key, Qdrant upsert-by-deterministic-id), so redoing already-completed
 * batches is redundant work, not a correctness risk. Not a queue, not
 * byte-offset resume — a full idempotent re-run, which is enough. */
export async function recoverStuckImports(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_IMPORT_GRACE_MS);
  const stuck = await DatasetVersion.find({
    status: { $in: ['importing', 'indexing'] },
    startedAt: { $lt: cutoff },
  }).select('+rawRows');

  if (stuck.length === 0) return;
  logger.warn(`Dataset import recovery: found ${stuck.length} stuck version(s) to resume`, { versionIds: stuck.map((v) => String(v._id)) });

  for (const datasetVersion of stuck) {
    const dataset = await Dataset.findOne({ _id: datasetVersion.datasetId, tenantId: datasetVersion.tenantId });
    if (!dataset) {
      // Parent Dataset is gone (e.g. deleted mid-import) — nothing to resume into.
      await DatasetVersion.findByIdAndUpdate(datasetVersion._id, { $set: { status: 'failed', lastError: 'Parent dataset no longer exists' }, $unset: { rawRows: 1 } });
      continue;
    }
    if (!datasetVersion.rawRows || datasetVersion.rawRows.length === 0) {
      // No persisted rows to resume from (e.g. a version created before this
      // recovery mechanism existed) — mark failed and clean up rather than
      // leaving it stuck forever.
      await DatasetVersion.findByIdAndUpdate(datasetVersion._id, { $set: { status: 'failed', lastError: 'No persisted rows available to resume' } });
      await cleanupFailedVersion(String(datasetVersion.tenantId), String(datasetVersion.datasetId), datasetVersion.version);
      continue;
    }
    logger.info('Resuming stuck dataset import', { datasetId: String(dataset._id), version: datasetVersion.version });
    await runImportPipeline(
      String(datasetVersion.tenantId), dataset, datasetVersion,
      dataset.sourceFileName, datasetVersion.columns, datasetVersion.rawRows,
    );
  }
}

/** Idempotent, resumable bulk Mongo write — batched `bulkWrite` upserts on
 * {datasetId, datasetVersion, recordId}, not per-row `create()` (the first
 * real bulk-write pattern in this codebase; see the plan's own note that
 * every existing import feature, e.g. Lead CSV import, does one-row-at-a-
 * time creates). Progress (`recordsInserted`) is persisted after EVERY
 * batch, not just at the end, so a crash mid-loop leaves a real, accurate
 * checkpoint a retry could resume from. */
async function ingestMongoRecords(
  tenantId: string, datasetId: string, version: number, sourceFileName: string,
  columns: IDatasetColumn[], rows: Record<string, unknown>[], datasetVersionDoc: InstanceType<typeof DatasetVersion>,
  imageMetaByRecordId?: Map<string, unknown>,
): Promise<void> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const did = new mongoose.Types.ObjectId(datasetId);
  const imageCol = columns.find((c) => c.semanticRole === 'image');
  let inserted = 0;
  let failed = 0;
  let cellsTruncated = 0;

  for (let i = 0; i < rows.length; i += MONGO_BATCH_SIZE) {
    const batch = rows.slice(i, i + MONGO_BATCH_SIZE);
    const ops = batch.map((row, idx) => {
      const rowNumber = i + idx + 1;
      const recordId = String(rowNumber);
      const { data, normalized, cellsTruncated: rowTruncated, identityKey } = buildRecordFields(row, columns);
      cellsTruncated += rowTruncated;
      // Merged in AFTER buildRecordFields() — see processDatasetImages()'s
      // own ProcessDatasetImagesResult comment for why this can't just ride
      // along on the row itself (buildRecordFields() only reads known
      // columns; a `<col>_meta` sibling key isn't one).
      if (imageCol && imageMetaByRecordId?.has(recordId)) {
        data[`${imageCol.normalizedName}_meta`] = imageMetaByRecordId.get(recordId);
      }
      return {
        updateOne: {
          // tenantId included in the filter (hardening Gap 4) — matches the
          // widened unique index in dataset-record.model.ts; not strictly
          // required for uniqueness (datasetId already determines tenantId)
          // but keeps every filter in this system tenant-scoped by construction.
          filter: { tenantId: tid, datasetId: did, datasetVersion: version, recordId },
          update: { $set: { tenantId: tid, datasetId: did, datasetVersion: version, recordId, sourceName: sourceFileName, sheetName: 'Sheet1', rowNumber, data, normalized, identityKey } },
          upsert: true,
        },
      };
    });
    try {
      const result: any = await DatasetRecord.bulkWrite(ops, { ordered: false });
      // Real, confirmed bug this fixes: with `ordered:false`, a per-document
      // Mongoose CAST/VALIDATION failure (e.g. a bad dataType inference
      // producing a value that fails the `normalized.<role>` schema's own
      // type) does NOT throw — Mongoose filters the invalid document out of
      // the actual write and reports it in `result.mongoose.validationErrors`
      // instead. Blindly trusting "no exception = batch.length succeeded"
      // silently dropped records with zero visible failure anywhere. Real
      // server-side errors (duplicate key, network, etc.) still throw and
      // are handled by the catch block below, unaffected by this check.
      const validationErrors: any[] = result?.mongoose?.validationErrors ?? [];
      const succeeded = batch.length - validationErrors.length;
      inserted += succeeded;
      if (validationErrors.length > 0) {
        failed += validationErrors.length;
        logger.warn('Dataset Mongo batch write had per-document validation errors', {
          tenantId, datasetId, version, batchStart: i, count: validationErrors.length,
          sample: validationErrors[0]?.message,
        });
      }
    } catch (err) {
      failed += batch.length;
      logger.warn('Dataset Mongo batch write failed', { tenantId, datasetId, version, batchStart: i, error: (err as Error).message });
    }
    await DatasetVersion.findByIdAndUpdate(datasetVersionDoc._id, { $set: { recordsInserted: inserted, recordsFailed: failed, cellsTruncated } });
  }
}

/** Idempotent, resumable Qdrant indexing — calls the AI service's
 * dataset-index-batch endpoint synchronously per batch (not fire-and-
 * forget: this loop needs the real indexed/failed counts back to update
 * DatasetVersion's own progress, and to know whether to mark this version
 * ready vs ready_with_warnings vs failed at the end). */
async function ingestQdrantVectors(
  tenantId: string, datasetId: string, version: number,
  columns: IDatasetColumn[], rows: Record<string, unknown>[], datasetVersionDoc: InstanceType<typeof DatasetVersion>,
): Promise<void> {
  await DatasetVersion.findByIdAndUpdate(datasetVersionDoc._id, { $set: { status: 'indexing' } });

  let indexed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += QDRANT_BATCH_SIZE) {
    const batch = rows.slice(i, i + QDRANT_BATCH_SIZE);
    const records = batch.map((row, idx) => ({
      recordId: String(i + idx + 1),
      semanticText: buildSemanticText(row, columns),
    })).filter((r) => r.semanticText.length > 0);

    if (records.length === 0) continue;

    try {
      const res = await axios.post(
        `${config.app.aiServiceUrl}/api/knowledge/dataset-index-batch`,
        { tenantId, datasetId, datasetVersion: version, records },
        { headers: { 'x-api-key': config.ai.internalApiKey }, timeout: 60000 },
      );
      indexed += res.data?.data?.indexed ?? 0;
      failed += res.data?.data?.failed ?? 0;
    } catch (err) {
      failed += records.length;
      logger.warn('Dataset Qdrant batch index failed', { tenantId, datasetId, version, batchStart: i, error: (err as Error).message });
    }
    await DatasetVersion.findByIdAndUpdate(datasetVersionDoc._id, { $set: { vectorsIndexed: indexed, vectorsFailed: failed } });
  }
}

/** Deterministic content hash of a record's `data` bag — key order in the
 * stored object can vary run to run (object key insertion order follows
 * `columns` order, which can change if a re-upload's mapping changes), so
 * this sorts keys before hashing rather than hashing raw insertion order,
 * which would report a false "updated" for a row whose values never
 * actually changed. */
function hashRecordData(data: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Part B — diff summary between this new version and whichever version
 * was active immediately before it. One indexed query per side (not a
 * full-table diff): fetch {identityKey, data} for both versions, match by
 * identityKey, classify by content-hash equality. Rows with no identityKey
 * (neither an identifier-role column nor a name+category pair was mapped)
 * are never matched across versions — every such row in the OLD version
 * counts as removed, every such row in the NEW version counts as added —
 * an ambiguous row is always treated as new, matching the plan's own
 * "never silently merged" rule, not a best-effort guess. */
async function computeVersionDiff(
  tenantId: string, datasetId: string, previousActiveVersion: number | undefined, newVersion: number,
): Promise<{ diffAdded: number; diffUpdated: number; diffRemoved: number; diffUnchanged: number }> {
  if (!previousActiveVersion) {
    const newCount = await DatasetRecord.countDocuments({ tenantId, datasetId, datasetVersion: newVersion });
    return { diffAdded: newCount, diffUpdated: 0, diffRemoved: 0, diffUnchanged: 0 };
  }

  const [oldRecords, newRecords] = await Promise.all([
    DatasetRecord.find({ tenantId, datasetId, datasetVersion: previousActiveVersion }).select('identityKey data').lean(),
    DatasetRecord.find({ tenantId, datasetId, datasetVersion: newVersion }).select('identityKey data').lean(),
  ]);

  const oldMap = new Map<string, string>();
  let removed = 0;
  for (const r of oldRecords) {
    if (!r.identityKey) { removed += 1; continue; }
    oldMap.set(r.identityKey, hashRecordData(r.data as Record<string, unknown>));
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const matchedOldKeys = new Set<string>();
  for (const r of newRecords) {
    const oldHash = r.identityKey ? oldMap.get(r.identityKey) : undefined;
    if (r.identityKey === null || oldHash === undefined) { added += 1; continue; }
    matchedOldKeys.add(r.identityKey!);
    const newHash = hashRecordData(r.data as Record<string, unknown>);
    if (newHash === oldHash) unchanged += 1; else updated += 1;
  }
  removed += oldMap.size - matchedOldKeys.size;

  return { diffAdded: added, diffUpdated: updated, diffRemoved: removed, diffUnchanged: unchanged };
}

/** Verifies real counts, decides the final status (mirroring the
 * ready/ready_with_warnings/failed states already shipped for website
 * crawl status), and only flips Dataset.activeVersion on a genuine
 * success — the atomic-activation guarantee from the plan's decision #3.
 * `failed` is reserved for zero usable records; partial success (some
 * rows/vectors failed but most succeeded) is `ready_with_warnings`, same
 * reasoning as the crawl-status work. */
async function finalizeVersion(tenantId: string, dataset: InstanceType<typeof Dataset>, datasetVersionDoc: InstanceType<typeof DatasetVersion>): Promise<void> {
  const fresh = await DatasetVersion.findById(datasetVersionDoc._id);
  if (!fresh) return;

  const status: DatasetVersionStatus =
    fresh.recordsInserted === 0 ? 'failed'
    : (fresh.recordsFailed > 0 || fresh.vectorsFailed > 0 || (fresh.imagesMissing ?? 0) > 0 || (fresh.imagesInvalid ?? 0) > 0) ? 'ready_with_warnings'
    : 'ready';

  // rawRows cleared here regardless of outcome (hardening Gap 2) — it's
  // working storage for a pending job, not a permanent copy of the upload;
  // once this version reaches ANY terminal status it's no longer "pending."
  await DatasetVersion.findByIdAndUpdate(fresh._id, { $set: { status, finishedAt: new Date() }, $unset: { rawRows: 1 } });

  if (status !== 'failed') {
    // Part B — diff against whichever version is active RIGHT NOW, read
    // fresh (not the possibly-stale `dataset` object carried through from
    // startImport(), which could predate a concurrent import's own
    // activation). Computed before this version's own activation so the
    // "previous" side of the diff is unambiguous even under overlapping imports.
    const currentDataset = await Dataset.findById(dataset._id).lean();
    const diff = await computeVersionDiff(tenantId, String(dataset._id), currentDataset?.activeVersion, fresh.version);
    await DatasetVersion.findByIdAndUpdate(fresh._id, { $set: diff });

    // Atomic, monotonic activation (hardening Gap 1) — only ever advances
    // activeVersion forward. Without this guard, two overlapping imports
    // (upload A, then upload B before A finishes) could have A's finalize
    // call stomp activeVersion back down below B's if A happens to finish
    // second — silently regressing the live dataset to older data.
    await Dataset.findOneAndUpdate(
      { _id: dataset._id, $or: [{ activeVersion: { $exists: false } }, { activeVersion: { $lt: fresh.version } }] },
      { $set: { activeVersion: fresh.version } },
    );
  } else {
    await cleanupFailedVersion(tenantId, String(dataset._id), fresh.version);
  }
}

/** A version that never reaches ready/ready_with_warnings is cleaned up —
 * its partial DatasetRecords deleted from Mongo and its partial vectors
 * deleted from Qdrant — rather than left as permanent orphaned data from a
 * failed attempt (decision #3). The previous version's own activeVersion
 * pointer is untouched throughout, so the chatbot never sees a gap. */
async function cleanupFailedVersion(tenantId: string, datasetId: string, version: number): Promise<void> {
  await DatasetRecord.deleteMany({ tenantId, datasetId, datasetVersion: version }).catch((err) => {
    logger.warn('Failed-version Mongo cleanup error', { tenantId, datasetId, version, error: (err as Error).message });
  });
  await axios.delete(
    `${config.app.aiServiceUrl}/api/knowledge/dataset-index/${datasetId}/${version}`,
    { params: { tenantId }, headers: { 'x-api-key': config.ai.internalApiKey }, timeout: 30000 },
  ).catch((err) => {
    logger.warn('Failed-version Qdrant cleanup error', { tenantId, datasetId, version, error: (err as Error).message });
  });
}

export async function listDatasets(tenantId: string) {
  return Dataset.find({ tenantId }).sort({ updatedAt: -1 }).lean();
}

export async function getDatasetById(tenantId: string, datasetId: string) {
  return Dataset.findOne({ _id: datasetId, tenantId }).lean();
}

export async function getActiveVersion(tenantId: string, datasetId: string) {
  const ds = await Dataset.findOne({ _id: datasetId, tenantId }).lean();
  if (!ds?.activeVersion) return null;
  return DatasetVersion.findOne({ tenantId, datasetId, version: ds.activeVersion }).lean();
}

/** The column schema (originalName + semanticRole only, no raw data) for
 * the query router's fast-path/classifier — enough for either to know
 * which fields exist and what role each plays, without ever seeing actual
 * row content. */
export async function getDatasetSchemaForChatbot(tenantId: string, datasetId: string) {
  const active = await getActiveVersion(tenantId, datasetId);
  if (!active) return null;
  // normalizedName included (hardening Gap 5) so the calling tool can
  // relabel a result's sanitized data keys back to their original,
  // human-readable header for display/citation — DatasetRecord.data is
  // keyed by normalizedName, never by the raw header, so without this the
  // visitor would see snake_case internal keys in the answer.
  return active.columns.map((c) => ({ originalName: c.originalName, normalizedName: c.normalizedName, semanticRole: c.semanticRole }));
}

export async function setAvailableToChatbot(tenantId: string, datasetId: string, availableToChatbot: boolean) {
  return Dataset.findOneAndUpdate({ _id: datasetId, tenantId }, { $set: { availableToChatbot } }, { new: true });
}

export async function deleteDataset(tenantId: string, datasetId: string): Promise<void> {
  const versions = await DatasetVersion.find({ tenantId, datasetId }).select('version').lean();
  await DatasetRecord.deleteMany({ tenantId, datasetId });
  await DatasetVersion.deleteMany({ tenantId, datasetId });
  await Dataset.deleteOne({ _id: datasetId, tenantId });
  for (const v of versions) {
    await axios.delete(
      `${config.app.aiServiceUrl}/api/knowledge/dataset-index/${datasetId}/${v.version}`,
      { params: { tenantId }, headers: { 'x-api-key': config.ai.internalApiKey }, timeout: 30000 },
    ).catch(() => {});
  }
}
