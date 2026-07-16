import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listQuotations,
  getQuotationById,
  createQuotation,
  updateQuotation,
  deleteQuotation,
} from './quotation.service';
import { logTimeline } from '../timeline/timeline.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listQuotations(req.tenantId!, req.query, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getQuotationById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Quotation not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createQuotation({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    logTimeline(req.tenantId!, 'quotation', String(item._id), 'created', `Quotation ${(item as any).quotationId} created`, req.user?.userId).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateQuotation(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Quotation not found', 404);
    const action = req.body.status ? 'status_changed' : 'updated';
    const desc   = req.body.status ? `Status changed to ${req.body.status}` : `Quotation ${(item as any).quotationId} updated`;
    logTimeline(req.tenantId!, 'quotation', String(item._id), action as any, desc, req.user?.userId).catch(() => {});
    if (req.body.status === 'approved') {
      autoLockIfConfigured(req.tenantId!, 'quotations', String(item._id), 'approved', req.user?.userId ?? 'system').catch(() => {});
    }
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteQuotation(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Quotation not found', 404);
    logTimeline(req.tenantId!, 'quotation', req.params.id, 'deleted', 'Quotation deleted', req.user?.userId).catch(() => {});
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
