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
import { logAuditEvent } from '../../logs/audit-log.model';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { uploadToS3 } from '../../../services/s3.service';
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listWorkorders(req.tenantId!, req.query, req.branchId, resolveEffectiveScope(req, 'workorders'));
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getWorkorderById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'workorders'));
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
    logTimeline(req.tenantId!, 'workorder', String(item._id), 'created', `Work order ${(item as any).workOrderId} created`, req.user?.userId,
      { status: (item as any).status, scheduledDate: (item as any).scheduledDate }).catch(() => {});
    runAutomationsOnCreate(req.tenantId!, 'workorder', item as any).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await getWorkorderById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'workorders'));
    const item = await updateWorkorder(req.params.id, req.tenantId!, req.body, resolveEffectiveScope(req, 'workorders'));
    if (!item) return sendError(res, 'Work order not found', 404);
    const action = req.body.status ? 'status_changed' : 'updated';
    const desc   = req.body.status
      ? `Status changed to ${req.body.status}`
      : `Work order ${(item as any).workOrderId} updated`;
    logTimeline(req.tenantId!, 'workorder', String(item._id), action as any, desc, req.user?.userId,
      req.body.status ? { previousStatus: (prev as any)?.status, newStatus: req.body.status } : undefined).catch(() => {});
    if (req.body.status) {
      const completedKey = await getOutcomeStageKey(req.tenantId!, 'workorder', 'completed', 'completed');
      if (req.body.status === completedKey) {
        autoLockIfConfigured(req.tenantId!, 'workorders', String(item._id), completedKey, req.user?.userId ?? 'system').catch(() => {});
      }
      runAutomations(req.tenantId!, 'workorder', item as any, req.body.status).catch(() => {});
    }
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'workorder', prev as any, item as any).catch(() => {});
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteWorkorder(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'workorders'));
    if (!item) return sendError(res, 'Work order not found', 404);
    logTimeline(req.tenantId!, 'workorder', req.params.id, 'deleted', `Work order deleted`, req.user?.userId,
      { status: (item as any).status }).catch(() => {});
    runAutomationsOnDelete(req.tenantId!, 'workorder', item as any).catch(() => {});
    logAuditEvent('workorder.deleted',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'WorkOrder', targetId: req.params.id, detail: { before: { status: (item as any).status } } },
    );
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
      await updateWorkorder(id, req.tenantId!, { signatureUrl: url }, resolveEffectiveScope(req, 'workorders'));
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
      const current  = await getWorkorderById(id, req.tenantId!, resolveEffectiveScope(req, 'workorders'));
      const existing = (current as any)?.photos ?? [];
      await updateWorkorder(id, req.tenantId!, { photos: [...existing, ...urls] }, resolveEffectiveScope(req, 'workorders'));
      results.photos = urls;
      logTimeline(req.tenantId!, 'workorder', id, 'uploaded', `${photos.length} photo(s) uploaded`, req.user?.userId).catch(() => {});
    }

    if (!sigFiles.length && !photos.length) return sendError(res, 'No files received', 400);
    sendSuccess(res, results);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
