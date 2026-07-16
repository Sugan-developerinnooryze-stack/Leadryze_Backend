import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendCreated, sendError } from '../../../utils/response';
import {
  listCustomFields, getCustomFieldById,
  createCustomField, updateCustomField, deleteCustomField,
} from './custom-field.service';
import { uploadToS3 } from '../../../services/s3.service';

const IMAGE_MAX = 5 * 1024 * 1024;  // 5 MB
const VIDEO_MAX = 10 * 1024 * 1024; // 10 MB

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function list(req: AuthRequest, res: Response) {
  try {
    const items = await listCustomFields(req.tenantId!, req.query.module as string | undefined);
    return sendSuccess(res, items);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getCustomFieldById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Custom field not found', 404);
    return sendSuccess(res, item);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createCustomField(req.tenantId!, req.body);
    return sendCreated(res, item);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateCustomField(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Custom field not found', 404);
    return sendSuccess(res, item);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteCustomField(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Custom field not found', 404);
    return sendSuccess(res, { message: 'Deleted' });
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

// ── Upload helpers ─────────────────────────────────────────────────────────────

function collectFiles(req: AuthRequest): Express.Multer.File[] {
  const map = req.files as Record<string, Express.Multer.File[]> | undefined;
  const single   = map?.['file']   ?? [];
  const multiple = map?.['files']  ?? [];
  return [...single, ...multiple];
}

async function uploadFiles(
  files: Express.Multer.File[],
  tenantId: string,
  folder: string,
  maxBytes: number,
): Promise<{ urls: string[]; error?: string }> {
  for (const f of files) {
    if (f.size > maxBytes) {
      const limitMb = Math.round(maxBytes / 1024 / 1024);
      return { urls: [], error: `"${f.originalname}" exceeds the ${limitMb} MB size limit` };
    }
  }
  const urls = await Promise.all(
    files.map((f) =>
      uploadToS3({ tenantId, folder, filename: f.originalname, mimetype: f.mimetype, buffer: f.buffer })
    )
  );
  return { urls };
}

// ── POST /upload/image  (5 MB, images + PDFs) ─────────────────────────────────
export async function uploadImageFiles(req: AuthRequest, res: Response) {
  try {
    const files = collectFiles(req);
    if (!files.length) return sendError(res, 'No file provided', 400);

    const { urls, error } = await uploadFiles(files, req.tenantId!, 'media/images', IMAGE_MAX);
    if (error) return sendError(res, error, 400);

    if (files.length === 1) return sendSuccess(res, { url: urls[0] }, 'Uploaded');
    return sendSuccess(res, { urls }, 'Uploaded');
  } catch (err: any) {
    return sendError(res, err.message, 500);
  }
}

// ── POST /upload/video  (10 MB, videos) ───────────────────────────────────────
export async function uploadVideoFiles(req: AuthRequest, res: Response) {
  try {
    const files = collectFiles(req);
    if (!files.length) return sendError(res, 'No file provided', 400);

    const { urls, error } = await uploadFiles(files, req.tenantId!, 'media/videos', VIDEO_MAX);
    if (error) return sendError(res, error, 400);

    if (files.length === 1) return sendSuccess(res, { url: urls[0] }, 'Uploaded');
    return sendSuccess(res, { urls }, 'Uploaded');
  } catch (err: any) {
    return sendError(res, err.message, 500);
  }
}

// ── POST /upload  (legacy mixed endpoint) ─────────────────────────────────────
export async function uploadMedia(req: AuthRequest, res: Response) {
  try {
    const files = collectFiles(req);
    if (!files.length) return sendError(res, 'No file provided', 400);

    // Per-file size check: videos get 10 MB, images/PDFs get 5 MB
    for (const f of files) {
      const isVideo = f.mimetype.startsWith('video/');
      const maxBytes = isVideo ? VIDEO_MAX : IMAGE_MAX;
      const limitMb  = isVideo ? 10 : 5;
      if (f.size > maxBytes) {
        return sendError(res, `"${f.originalname}" exceeds the ${limitMb} MB size limit`, 400);
      }
    }

    const folder = files.some((f) => f.mimetype.startsWith('video/')) ? 'media/videos' : 'media/images';
    const urls = await Promise.all(
      files.map((f) =>
        uploadToS3({ tenantId: req.tenantId!, folder, filename: f.originalname, mimetype: f.mimetype, buffer: f.buffer })
      )
    );

    if (files.length === 1) return sendSuccess(res, { url: urls[0] }, 'Uploaded');
    return sendSuccess(res, { urls }, 'Uploaded');
  } catch (err: any) {
    return sendError(res, err.message, 500);
  }
}
