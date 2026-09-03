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
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listInvoices(req.tenantId!, req.query, req.branchId, resolveEffectiveScope(req, 'invoices'));
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getInvoiceById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'invoices'));
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
    logTimeline(req.tenantId!, 'invoice', String(item._id), 'created', `Invoice ${(item as any).invoiceId} created`, req.user?.userId,
      { status: (item as any).status, amount: (item as any).servicesAmountWithTax }).catch(() => {});
    runAutomationsOnCreate(req.tenantId!, 'invoice', item as any).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await getInvoiceById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'invoices'));
    const item = await updateInvoice(req.params.id, req.tenantId!, req.body, resolveEffectiveScope(req, 'invoices'));
    if (!item) return sendError(res, 'Invoice not found', 404);
    const action = req.body.status ? 'status_changed' : 'updated';
    const desc   = req.body.status ? `Status changed to ${req.body.status}` : `Invoice ${(item as any).invoiceId} updated`;
    logTimeline(req.tenantId!, 'invoice', String(item._id), action as any, desc, req.user?.userId,
      req.body.status
        ? { previousStatus: (prev as any)?.status, newStatus: req.body.status, amount: (item as any).servicesAmountWithTax }
        : { amount: (item as any).servicesAmountWithTax },
    ).catch(() => {});
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
    const item = await deleteInvoice(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'invoices'));
    if (!item) return sendError(res, 'Invoice not found', 404);
    logTimeline(req.tenantId!, 'invoice', req.params.id, 'deleted', 'Invoice deleted', req.user?.userId,
      { status: (item as any).status, amount: (item as any).servicesAmountWithTax }).catch(() => {});
    runAutomationsOnDelete(req.tenantId!, 'invoice', item as any).catch(() => {});
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
