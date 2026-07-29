import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listInvoices,
  getInvoiceById,
  createInvoice,
  updateInvoice,
  deleteInvoice,
} from './invoice.service';
import { logTimeline } from '../timeline/timeline.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listInvoices(req.tenantId!, req.query, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getInvoiceById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Invoice not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createInvoice({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    logTimeline(req.tenantId!, 'invoice', String(item._id), 'created', `Invoice ${(item as any).invoiceId} created`, req.user?.userId).catch(() => {});
    runAutomationsOnCreate(req.tenantId!, 'invoice', item as any).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await getInvoiceById(req.params.id, req.tenantId!);
    const item = await updateInvoice(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Invoice not found', 404);
    const action = req.body.status ? 'status_changed' : 'updated';
    const desc   = req.body.status ? `Status changed to ${req.body.status}` : `Invoice ${(item as any).invoiceId} updated`;
    logTimeline(req.tenantId!, 'invoice', String(item._id), action as any, desc, req.user?.userId).catch(() => {});
    if (req.body.status) {
      const paidKey = await getOutcomeStageKey(req.tenantId!, 'invoice', 'paid', 'paid');
      if (req.body.status === paidKey) {
        autoLockIfConfigured(req.tenantId!, 'invoices', String(item._id), paidKey, req.user?.userId ?? 'system').catch(() => {});
      }
      runAutomations(req.tenantId!, 'invoice', item as any, req.body.status).catch(() => {});
    }
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'invoice', prev as any, item as any).catch(() => {});
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteInvoice(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Invoice not found', 404);
    logTimeline(req.tenantId!, 'invoice', req.params.id, 'deleted', 'Invoice deleted', req.user?.userId).catch(() => {});
    runAutomationsOnDelete(req.tenantId!, 'invoice', item as any).catch(() => {});
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
