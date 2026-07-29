import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { TemplateAsset } from './template-asset.model';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../../services/s3.service';

/** GET / — tenant's uploaded assets, newest first. */
export async function list(req: AuthRequest, res: Response) {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || '1')));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50')));

    const filter = { tenantId: req.tenantId };
    const [items, total] = await Promise.all([
      TemplateAsset.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      TemplateAsset.countDocuments(filter),
    ]);
    sendSuccess(res, items, 'Success', 200, { total, page, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to list assets', 500);
  }
}

/** POST / — upload a new asset (multipart, field name "file"). */
export async function uploadAsset(req: AuthRequest, res: Response) {
  try {
    if (!req.file) return sendError(res, 'file is required', 400);

    const url = await uploadToS3({
      tenantId: req.tenantId!,
      folder:   'template-assets',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer:   req.file.buffer,
    });

    const asset = await TemplateAsset.create({
      tenantId:   req.tenantId,
      url,
      key:        keyFromUrl(url),
      filename:   req.file.originalname,
      mimetype:   req.file.mimetype,
      size:       req.file.size,
      uploadedBy: req.user?.userId,
    });

    res.status(201).json({ success: true, data: asset });
  } catch (err: any) {
    sendError(res, err.message ?? 'Upload failed', 500);
  }
}

/** DELETE /:id — removes the record and best-effort deletes the S3 object. */
export async function remove(req: AuthRequest, res: Response) {
  try {
    const asset = await TemplateAsset.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!asset) return sendError(res, 'Not found', 404);
    try {
      await deleteFromS3(asset.key);
    } catch {
      // S3 cleanup is best-effort — the Mongo record is already gone, which is
      // what matters for the asset no longer being listed/draggable.
    }
    sendSuccess(res, null, 'Deleted');
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to delete asset', 500);
  }
}
