import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listWorkorders,
  getWorkorderById,
  createWorkorder,
  updateWorkorder,
  deleteWorkorder,
  checkStaffAvailability,
  findNearestStaff,
} from './workorder.service';
import { logTimeline } from '../timeline/timeline.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { uploadToS3 } from '../../../services/s3.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listWorkorders(req.tenantId!, req.query, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getWorkorderById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Work order not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createWorkorder({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    logTimeline(req.tenantId!, 'workorder', String(item._id), 'created', `Work order ${(item as any).workOrderId} created`, req.user?.userId).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateWorkorder(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Work order not found', 404);
    const action = req.body.status ? 'status_changed' : 'updated';
    const desc   = req.body.status
      ? `Status changed to ${req.body.status}`
      : `Work order ${(item as any).workOrderId} updated`;
    logTimeline(req.tenantId!, 'workorder', String(item._id), action as any, desc, req.user?.userId, req.body.status ? { status: req.body.status } : undefined).catch(() => {});
    if (req.body.status === 'completed') {
      autoLockIfConfigured(req.tenantId!, 'workorders', String(item._id), 'completed', req.user?.userId ?? 'system').catch(() => {});
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteWorkorder(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Work order not found', 404);
    logTimeline(req.tenantId!, 'workorder', req.params.id, 'deleted', `Work order deleted`, req.user?.userId).catch(() => {});
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function nearestStaff(req: AuthRequest, res: Response) {
  try {
    const { lat, lng, skills, date, limit } = req.query as Record<string, string | undefined>;
    if (!lat || !lng) return sendError(res, 'lat and lng are required', 400);
    const results = await findNearestStaff(req.tenantId!, {
      lat:    parseFloat(lat),
      lng:    parseFloat(lng),
      skills: skills ? skills.split(',').filter(Boolean) : undefined,
      date,
      limit:  limit ? parseInt(limit, 10) : 10,
    });
    sendSuccess(res, results);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function staffAvailability(req: AuthRequest, res: Response) {
  try {
    const { staffId, date, datetime, duration, excludeId } = req.query as {
      staffId?: string; date?: string; datetime?: string; duration?: string; excludeId?: string;
    };
    if (!staffId || !date) return sendError(res, 'staffId and date are required', 400);
    const result = await checkStaffAvailability(req.tenantId!, staffId, date, {
      datetime,
      duration: duration ? parseFloat(duration) : undefined,
      excludeId,
    });
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function uploadFiles(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const filesMap = req.files as Record<string, Express.Multer.File[]> | undefined;
    const photos   = filesMap?.['photos']    ?? [];
    const sigFiles = filesMap?.['signature'] ?? [];

    const results: Record<string, any> = {};

    if (sigFiles.length > 0) {
      const f = sigFiles[0];
      const url = await uploadToS3({
        tenantId: req.tenantId!,
        folder:   'workorders/signatures',
        filename: f.originalname,
        mimetype: f.mimetype,
        buffer:   f.buffer,
      });
      await updateWorkorder(id, req.tenantId!, { signatureUrl: url });
      results.signatureUrl = url;
      logTimeline(req.tenantId!, 'workorder', id, 'uploaded', 'Signature uploaded', req.user?.userId).catch(() => {});
    }

    if (photos.length > 0) {
      const urls = await Promise.all(
        photos.map((f) =>
          uploadToS3({
            tenantId: req.tenantId!,
            folder:   'workorders/photos',
            filename: f.originalname,
            mimetype: f.mimetype,
            buffer:   f.buffer,
          })
        )
      );
      const current  = await getWorkorderById(id, req.tenantId!);
      const existing = (current as any)?.photos ?? [];
      await updateWorkorder(id, req.tenantId!, { photos: [...existing, ...urls] });
      results.photos = urls;
      logTimeline(req.tenantId!, 'workorder', id, 'uploaded', `${photos.length} photo(s) uploaded`, req.user?.userId).catch(() => {});
    }

    if (!sigFiles.length && !photos.length) return sendError(res, 'No files received', 400);
    sendSuccess(res, results);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
