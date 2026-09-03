import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { Upload } from '@aws-sdk/lib-storage';
import { s3Client, buildPublicUrl } from '../../../services/s3.service';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { TempImageUpload } from './temp-image-upload.model';
import { IDatasetColumn } from './dataset-version.model';

// ── Real limits — every one of these is a deliberate security/abuse
// boundary, not a performance tweak. See the plan's own "ZIP security" /
// "image dimension limits" sections for the reasoning behind each. ────────
const MAX_ZIP_ENTRY_COUNT = 1000;
const MAX_ZIP_DECLARED_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500MB — zip-bomb defense
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB per source file
const MAX_IMAGE_DIMENSION_PX = 10_000;
const MAX_IMAGE_MEGAPIXELS = 40;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface ImageValidationResult {
  ok: boolean;
  reason?: string;
}

/** Normalizes a filename for matching — trim/lowercase/Unicode-NFC, exactly
 * the same on both sides of the comparison (ZIP entry basenames AND the
 * Excel's own declared image-column value), so "FF-BV100.JPG" in Excel
 * matches "ff-bv100.jpg" in the ZIP without either side needing to match
 * the other's exact casing. Deliberately does NOT strip/alter any other
 * characters — over-aggressive normalization risks two genuinely different
 * filenames colliding. */
export function normalizeImageFilename(name: string): string {
  return name.trim().toLowerCase().normalize('NFC');
}

/** ZIP entry paths are untrusted, author-supplied strings whose separator
 * depends on whatever tool built the ZIP, not on the OS this server happens
 * to run on. Windows' own built-in zip tools (Explorer's "Compress to ZIP
 * file", PowerShell's Compress-Archive) both store entries with backslash
 * separators (e.g. "product_image\photo.jpg") despite the ZIP spec calling
 * for forward slashes — confirmed directly against Compress-Archive's own
 * output. Node's `path.basename()` is OS-dependent: it strips backslashes
 * on Windows but NOT on Linux/Mac, where production actually runs — so a
 * ZIP built by zipping a folder in Windows Explorer would silently fail to
 * match ANY of its images once deployed, with no indication why. Normalize
 * both separators to "/" first so basename extraction is correct regardless
 * of which OS built the ZIP or which OS is running this code. */
function crossPlatformBasename(entryName: string): string {
  return path.posix.basename(entryName.replace(/\\/g, '/'));
}

interface SafeZipEntry {
  buffer: Buffer;
}

/** The real ZIP-security gate — the tenant-supplied ZIP itself is untrusted
 * input, not just the images inside it. Run once, before any entry is
 * extracted, matching this project's "trace/validate first" discipline.
 * Returns a clean, normalized-basename-keyed map. A basename claimed by two
 * or more DIFFERENT full paths is deliberately excluded (ambiguous) rather
 * than guessed at — see ambiguousBasenames in the return value. */
export function openImageZipSafely(zipPath: string): {
  entries: Map<string, SafeZipEntry>;
  ambiguousBasenames: Set<string>;
} {
  const zip = new AdmZip(zipPath);
  const rawEntries = zip.getEntries();

  if (rawEntries.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(`ZIP contains too many files (${rawEntries.length}, max ${MAX_ZIP_ENTRY_COUNT})`);
  }

  let declaredUncompressedTotal = 0;
  for (const entry of rawEntries) {
    declaredUncompressedTotal += entry.header.size;
  }
  if (declaredUncompressedTotal > MAX_ZIP_DECLARED_UNCOMPRESSED_BYTES) {
    throw new Error('ZIP declares an implausibly large uncompressed size (rejected as a possible zip bomb)');
  }

  // basename -> full path(s) that produced it, so a genuine collision (two
  // different folders, same filename) can be detected before any buffer is
  // even read, not discovered mid-processing.
  const pathsByBasename = new Map<string, string[]>();
  for (const entry of rawEntries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName;
    // Real path-traversal defense: reject '..', a leading '/', or a
    // Windows-style absolute path (drive letter) outright — this entry name
    // is never handed to any filesystem/extraction call, only used as a map
    // key and for its own basename.
    if (entryName.includes('..') || entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) {
      throw new Error(`ZIP contains an unsafe entry path: ${entryName}`);
    }
    if (entry.header.size > MAX_SOURCE_IMAGE_BYTES) {
      // Not fatal for the whole ZIP — this single entry just never becomes
      // a match candidate; the affected row(s) report "invalid" via the
      // normal missing/invalid accounting in processDatasetImages().
      continue;
    }
    const base = normalizeImageFilename(crossPlatformBasename(entryName));
    const list = pathsByBasename.get(base) ?? [];
    list.push(entryName);
    pathsByBasename.set(base, list);
  }

  const ambiguousBasenames = new Set<string>();
  const entries = new Map<string, SafeZipEntry>();
  for (const [base, paths] of pathsByBasename) {
    if (paths.length > 1) {
      ambiguousBasenames.add(base);
      continue;
    }
    const zipEntry = zip.getEntry(paths[0]);
    if (!zipEntry) continue;
    entries.set(base, { buffer: zipEntry.getData() });
  }

  return { entries, ambiguousBasenames };
}

/** Real format validation — sharp's own decode attempt IS the validator
 * (throws on a non-image buffer regardless of what extension/mime claims),
 * not a separate signature-sniffing dependency. SVG is excluded before ever
 * reaching sharp (rasterizable via librsvg, but can embed external
 * references/scripts — a real, disclosed risk not worth taking here). */
export async function validateImageBuffer(buffer: Buffer, declaredFilename: string): Promise<ImageValidationResult> {
  const ext = path.extname(declaredFilename).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `Unsupported image format: ${ext || '(no extension)'}` };
  }
  if (buffer.length > MAX_SOURCE_IMAGE_BYTES) {
    return { ok: false, reason: `Image file too large (${Math.round(buffer.length / 1024 / 1024)}MB, max ${MAX_SOURCE_IMAGE_BYTES / 1024 / 1024}MB)` };
  }
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    return { ok: false, reason: 'File is not a valid, decodable image' };
  }
  const { width, height } = metadata;
  if (!width || !height) {
    return { ok: false, reason: 'Could not determine image dimensions' };
  }
  if (width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX) {
    return { ok: false, reason: `Image dimensions too large (${width}x${height}, max ${MAX_IMAGE_DIMENSION_PX}px per side)` };
  }
  const megapixels = (width * height) / 1_000_000;
  if (megapixels > MAX_IMAGE_MEGAPIXELS) {
    return { ok: false, reason: `Image has too many pixels (${megapixels.toFixed(1)}MP, max ${MAX_IMAGE_MEGAPIXELS}MP)` };
  }
  return { ok: true };
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
  mimeType: string;
}

/** fit:'inside' (never 'cover'/stretch) — a real industrial product photo's
 * actual aspect ratio is preserved, never forced into a square crop.
 * withoutEnlargement:true — a source image already smaller than the target
 * is never upscaled (would only add noise, not real detail). */
export async function generateThumbnail(buffer: Buffer): Promise<ProcessedImage> {
  const out = await sharp(buffer).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, size: out.info.size, mimeType: 'image/webp' };
}

export async function generateMainImage(buffer: Buffer): Promise<ProcessedImage> {
  const out = await sharp(buffer).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, size: out.info.size, mimeType: 'image/webp' };
}

/** Version-scoped key (see the plan's decision #6) — mirrors
 * DatasetRecord's own real identity (tenantId+datasetId+datasetVersion+
 * recordId) so a V2 re-import's images never collide with or require
 * deleting V1's, regardless of whether V2 succeeds, fails, or is still in
 * progress. Thin wrapper over the EXISTING uploadToS3()-equivalent upload
 * path (s3Client/Upload, same as s3.service.ts's own uploadToS3()) — kept
 * local here only so the key-building convention is explicit and co-located
 * with the rest of this feature, not a second S3 client. */
export async function uploadProcessedImage(
  tenantId: string, datasetId: string, version: number, recordId: string,
  kind: 'thumbnail' | 'image', processed: ProcessedImage,
): Promise<{ key: string; url: string }> {
  // Matches this codebase's one established key convention exactly
  // (s3.service.ts's buildKey(): Leadryze_Bucket/{tenantId}/{folder}/...) —
  // tenantId sits directly under Leadryze_Bucket, not under an extra
  // "tenants/" segment, so this doesn't create a second, inconsistent
  // tenant-folder shape alongside every other feature's uploads (logos,
  // documents, etc.) in the same bucket.
  const key = `Leadryze_Bucket/${tenantId}/datasets/${datasetId}/versions/${version}/records/${recordId}/${kind}.webp`;
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: config.s3.bucket, Key: key, Body: processed.buffer, ContentType: processed.mimeType },
  });
  await upload.done();
  return { key, url: buildPublicUrl(key) };
}

export interface DatasetImageMeta {
  key: string;
  url: string;
  thumbnailKey: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  size: number;
  mimeType: string;
}

export interface ProcessDatasetImagesResult {
  imagesFound: number;
  imagesMissing: number;
  imagesInvalid: number;
  /** recordId ('1', '2', ...) -> the structured metadata for that row's
   * image. Real, confirmed gap this design closes: buildRecordFields()
   * (dataset-value.service.ts) only ever reads fields present in the
   * CONFIRMED `columns` list — a `<col>_meta` key mutated directly onto the
   * raw row is silently dropped, since it's not a known column, never
   * reaching `data` at all (caught live during verification: the meta
   * object was genuinely absent from the stored record). The caller
   * (dataset.service.ts's ingestMongoRecords()) merges this map into each
   * record's `data` itself, AFTER buildRecordFields() runs, keyed by the
   * exact same recordId convention (row index + 1) both functions already
   * use independently — dataset-value.service.ts still needs zero changes,
   * just not via row-mutation as originally designed. */
  imageMetaByRecordId: Map<string, DatasetImageMeta>;
}

/** The orchestrator. No-ops immediately (returns all-zero counts, empty
 * map) when there's no `image`-role column or no imageZipRef — Mode A /
 * no-image imports pay zero cost from this feature existing. Mutates
 * `rows` IN PLACE for the main image URL itself (each matched row's
 * image-column value becomes the real public URL) — that part DOES survive
 * buildRecordFields() unchanged, since the image column is a real, known
 * column; only the extra metadata needed the map-based approach above. */
export async function processDatasetImages(
  tenantId: string, datasetId: string, version: number,
  imageZipRef: string | undefined, columns: IDatasetColumn[], rows: Array<Record<string, unknown>>,
): Promise<ProcessDatasetImagesResult> {
  const result: ProcessDatasetImagesResult = { imagesFound: 0, imagesMissing: 0, imagesInvalid: 0, imageMetaByRecordId: new Map() };
  if (!imageZipRef) return result;

  const imageCol = columns.find((c) => c.semanticRole === 'image');
  if (!imageCol) return result;

  const upload = await TempImageUpload.findOne({ ref: imageZipRef, tenantId });
  if (!upload) {
    logger.warn('processDatasetImages: imageZipRef not found or not owned by this tenant — skipping image import', { tenantId, datasetId, imageZipRef });
    return result;
  }

  try {
    let zip: ReturnType<typeof openImageZipSafely>;
    try {
      zip = openImageZipSafely(upload.tempPath);
    } catch (err) {
      logger.warn('Dataset image ZIP failed safety checks — no images imported for this version', { tenantId, datasetId, error: (err as Error).message });
      result.imagesMissing = rows.length;
      return result;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const recordId = String(i + 1);
      const rawValue = row[imageCol.originalName];
      const declaredFilename = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!declaredFilename) continue; // no image declared for this row — not an error, just nothing to do

      const normalized = normalizeImageFilename(declaredFilename);
      if (zip.ambiguousBasenames.has(normalized)) {
        result.imagesInvalid++;
        logger.warn('Dataset image import: ambiguous filename (matches multiple ZIP entries)', { tenantId, datasetId, recordId, filename: declaredFilename });
        continue;
      }
      const entry = zip.entries.get(normalized);
      if (!entry) {
        result.imagesMissing++;
        continue;
      }

      const validation = await validateImageBuffer(entry.buffer, declaredFilename);
      if (!validation.ok) {
        result.imagesInvalid++;
        logger.warn('Dataset image import: image rejected', { tenantId, datasetId, recordId, filename: declaredFilename, reason: validation.reason });
        continue;
      }

      // Real gap this closes: a transient failure here (an S3 hiccup, a
      // sharp encode error on an already-validated buffer) must NEVER take
      // down the whole import — only this one row's image. Without this
      // try/catch, an uncaught throw here propagates all the way up through
      // runImportPipeline()'s own catch, marking the ENTIRE dataset version
      // 'failed' over one bad image — directly contradicting the plan's
      // "missing/invalid images are warnings, never a reason to fail the
      // whole import" requirement.
      try {
        const [thumb, main] = await Promise.all([generateThumbnail(entry.buffer), generateMainImage(entry.buffer)]);
        const [thumbUpload, mainUpload] = await Promise.all([
          uploadProcessedImage(tenantId, datasetId, version, recordId, 'thumbnail', thumb),
          uploadProcessedImage(tenantId, datasetId, version, recordId, 'image', main),
        ]);

        row[imageCol.originalName] = mainUpload.url;
        result.imageMetaByRecordId.set(recordId, {
          key: mainUpload.key, url: mainUpload.url,
          thumbnailKey: thumbUpload.key, thumbnailUrl: thumbUpload.url,
          width: main.width, height: main.height, size: main.size, mimeType: main.mimeType,
        });
        result.imagesFound++;
      } catch (err) {
        result.imagesInvalid++;
        logger.warn('Dataset image import: processing/upload failed for one row — continuing with the rest', {
          tenantId, datasetId, recordId, filename: declaredFilename, error: (err as Error).message,
        });
      }
    }
  } finally {
    await cleanupTempImageUpload(upload.ref);
  }

  return result;
}

/** Second, explicit safety net alongside TempImageUpload's own TTL index —
 * the TTL index only ever removes the tracking DOC (24h), never the file on
 * disk. A tenant who uploads a ZIP and then never calls /import (abandons
 * the flow) would otherwise leak that file indefinitely. Called from
 * scheduler.service.ts on a real cron entry (hourly is plenty — this is a
 * grace-period sweep, not a time-critical operation), matching the exact
 * "stuck after N minutes/hours is abandoned, not still legitimately
 * running" reasoning dataset.service.ts's own recoverStuckImports() already
 * uses for stuck import versions. Uses a shorter grace period (2h) than the
 * tracking doc's own 24h TTL specifically so the FILE doesn't sit around
 * for a near-day even after it's obviously abandoned. */
const ORPHANED_UPLOAD_GRACE_MS = 2 * 60 * 60 * 1000;

export async function cleanupOrphanedImageUploads(): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHANED_UPLOAD_GRACE_MS);
  // A consumed upload's doc is already deleted (cleanupTempImageUpload()
  // removes it immediately in processDatasetImages()'s finally block), so
  // any doc that still exists past the grace period is, by construction,
  // one that was never consumed — no separate "consumed" flag needed.
  const orphaned = await TempImageUpload.find({ createdAt: { $lt: cutoff } });
  if (orphaned.length === 0) return;
  logger.info(`Dataset image upload cleanup: removing ${orphaned.length} orphaned/abandoned ZIP upload(s)`);
  for (const upload of orphaned) {
    await cleanupTempImageUpload(upload.ref);
  }
}

/** Deletes both halves of a temp upload's real footprint — the file on
 * disk AND its tracking doc — called from processDatasetImages()'s own
 * finally block (success or failure) and from cleanupOrphanedImageUploads()
 * above for the abandoned-upload case. Safe to call twice (e.g. the sweep
 * racing a just-finished import) — a missing file/doc is a silent no-op,
 * never a thrown error. */
export async function cleanupTempImageUpload(ref: string): Promise<void> {
  const upload = await TempImageUpload.findOne({ ref });
  if (!upload) return;
  try {
    await fs.promises.unlink(upload.tempPath);
  } catch {
    // Already gone, or never existed — fine, this is cleanup, not a
    // correctness-critical step.
  }
  await TempImageUpload.deleteOne({ ref });
}

export interface ImageMatchPreview {
  declared: number;
  matched: number;
  missing: number;
  ambiguous: number;
  missingFilenames: string[];
  ambiguousFilenames: string[];
}

/** Real, non-destructive preview of what processDatasetImages() would find —
 * called from the frontend's import popup right after a ZIP is attached, so
 * a filename mismatch (the exact bug hit during real verification: Excel
 * declared .jpg, the ZIP actually had .png) surfaces immediately instead of
 * only after a full import + DB check. Deliberately reuses
 * openImageZipSafely()/normalizeImageFilename() — the SAME matching logic
 * processDatasetImages() itself uses — rather than a separate client-side
 * reimplementation that could silently drift from the real behavior.
 * Read-only: never touches sharp/S3, and never cleans up the temp upload
 * (still needed for the real import that follows). */
export async function previewImageMatch(
  tenantId: string, imageZipRef: string, declaredFilenames: string[],
): Promise<ImageMatchPreview> {
  const upload = await TempImageUpload.findOne({ ref: imageZipRef, tenantId });
  if (!upload) {
    throw new Error('Image ZIP not found or expired — please re-attach it.');
  }

  let zip: ReturnType<typeof openImageZipSafely>;
  try {
    zip = openImageZipSafely(upload.tempPath);
  } catch (err) {
    // Whole ZIP fails its own safety checks — matches processDatasetImages()'s
    // own fallback for this case: every declared filename reports "missing".
    return {
      declared: declaredFilenames.length, matched: 0, missing: declaredFilenames.length, ambiguous: 0,
      missingFilenames: declaredFilenames, ambiguousFilenames: [],
    };
  }

  let matched = 0;
  const missingFilenames: string[] = [];
  const ambiguousFilenames: string[] = [];
  for (const raw of declaredFilenames) {
    const normalized = normalizeImageFilename(raw);
    if (zip.ambiguousBasenames.has(normalized)) {
      ambiguousFilenames.push(raw);
    } else if (zip.entries.has(normalized)) {
      matched++;
    } else {
      missingFilenames.push(raw);
    }
  }

  return {
    declared: declaredFilenames.length, matched, missing: missingFilenames.length, ambiguous: ambiguousFilenames.length,
    missingFilenames, ambiguousFilenames,
  };
}

/** Called by dataset.controller.ts's uploadImageZip() right after multer
 * has already written the file to disk — records real ownership so
 * startImport() can later verify the tenant match before ever reading it. */
export async function saveTempImageUpload(
  tenantId: string, createdBy: string, tempPath: string, originalFilename: string, sizeBytes: number,
): Promise<{ ref: string }> {
  const ref = crypto.randomUUID();
  const TTL_MS = 24 * 60 * 60 * 1000;
  await TempImageUpload.create({
    ref, tenantId, createdBy, tempPath, originalFilename, sizeBytes,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return { ref };
}
