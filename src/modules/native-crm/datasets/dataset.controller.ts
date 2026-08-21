import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './dataset.service';
import { DatasetVersion } from './dataset-version.model';
import { saveTempImageUpload, previewImageMatch } from './dataset-image.service';

export async function analyze(req: AuthRequest, res: Response) {
  try {
    const { headers, sampleRows } = req.body as { headers: string[]; sampleRows: Record<string, unknown>[] };
    const columns = svc.analyzeDatasetColumns(headers, sampleRows);
    sendSuccess(res, { columns });
  } catch { sendError(res, 'Failed to analyze file', 500); }
}

/** Real upload endpoint for a dataset image-import ZIP (dataset-image
 * import feature) — multer's uploadZip (upload.middleware.ts) has already
 * written the file to disk under a random, non-guessable name by the time
 * this runs; this handler only records real ownership so startImport() can
 * verify the tenant match before ever reading the file. */
export async function uploadImageZip(req: AuthRequest, res: Response) {
  try {
    const file = req.file;
    if (!file) return void sendError(res, 'No ZIP file uploaded', 400);
    const { ref } = await saveTempImageUpload(req.tenantId!, req.user?.userId ?? 'unknown', file.path, file.originalname, file.size);
    sendSuccess(res, { imageZipRef: ref }, 'ZIP uploaded');
  } catch (err: any) { sendError(res, err.message ?? 'Failed to upload image ZIP', 500); }
}

/** Read-only match preview (dataset-image import hardening) — called by the
 * frontend the moment a ZIP is attached in the import popup, so a filename
 * mismatch surfaces before the tenant commits to a full import rather than
 * only after checking the result. Never touches sharp/S3 and never
 * consumes/deletes the temp upload — that still happens exactly once, in
 * the real import via processDatasetImages(). */
export async function previewImageMatchHandler(req: AuthRequest, res: Response) {
  try {
    const { imageZipRef, declaredFilenames } = req.body as { imageZipRef: string; declaredFilenames: string[] };
    const result = await previewImageMatch(req.tenantId!, imageZipRef, declaredFilenames);
    sendSuccess(res, result);
  } catch (err: any) { sendError(res, err.message ?? 'Could not preview image match', 500); }
}

export async function startImport(req: AuthRequest, res: Response) {
  try {
    // startImport() itself only awaits the fast, synchronous part (create
    // Dataset/DatasetVersion, persist the rows) — the actual ingestion
    // pipeline continues in the background after this responds (hardening
    // Gap 8), so `version.status` here will normally still read
    // 'importing'; the frontend polls GET /:id/versions for real progress.
    const result = await svc.startImport(req.tenantId!, { ...req.body, createdBy: req.user?.userId });
    const version = await DatasetVersion.findOne({ tenantId: req.tenantId!, datasetId: result.datasetId, version: result.version }).lean();
    sendCreated(res, { ...result, status: version?.status, recordsInserted: version?.recordsInserted, vectorsIndexed: version?.vectorsIndexed, lastError: version?.lastError }, 'Dataset import started');
  } catch (err: any) { sendError(res, err.message ?? 'Import failed', 500); }
}

export async function list(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.listDatasets(req.tenantId!)); }
  catch { sendError(res, 'Failed to list datasets', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const dataset = await svc.getDatasetById(req.tenantId!, req.params.id);
    if (!dataset) return void sendError(res, 'Dataset not found', 404);
    const activeVersion = await svc.getActiveVersion(req.tenantId!, req.params.id);
    sendSuccess(res, { ...dataset, activeVersionDetail: activeVersion });
  } catch { sendError(res, 'Failed to fetch dataset', 500); }
}

export async function listVersions(req: AuthRequest, res: Response) {
  try {
    const versions = await DatasetVersion.find({ tenantId: req.tenantId!, datasetId: req.params.id }).sort({ version: -1 }).lean();
    sendSuccess(res, versions);
  } catch { sendError(res, 'Failed to list versions', 500); }
}

export async function toggleAvailable(req: AuthRequest, res: Response) {
  try {
    const updated = await svc.setAvailableToChatbot(req.tenantId!, req.params.id, req.body.availableToChatbot);
    if (!updated) return void sendError(res, 'Dataset not found', 404);
    sendSuccess(res, updated, 'Updated');
  } catch { sendError(res, 'Failed to update dataset', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const dataset = await svc.getDatasetById(req.tenantId!, req.params.id);
    if (!dataset) return void sendError(res, 'Dataset not found', 404);
    await svc.deleteDataset(req.tenantId!, req.params.id);
    sendSuccess(res, null, 'Deleted');
  } catch { sendError(res, 'Failed to delete dataset', 500); }
}
