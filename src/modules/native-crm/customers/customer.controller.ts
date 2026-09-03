import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
} from './customer.service';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';
import { resolveEffectiveScope } from '../shared/data-scope';
import { logTimeline } from '../timeline/timeline.service';
import { logAuditEvent } from '../../logs/audit-log.model';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'customers')?.viewRoles ?? [];
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listCustomers(req.tenantId!, req.query as any, req.branchId, resolveEffectiveScope(req, 'customers'));
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(items, 'customers', req.user!.role, viewRoles);
    sendPaginated(res, safeItems, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getCustomerById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'customers'));
    if (!item) return sendError(res, 'Customer not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(item, 'customers', req.user!.role, viewRoles));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createCustomer({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    logTimeline(req.tenantId!, 'customer', String((item as any)._id), 'created', `Customer "${(item as any).name}" created`, req.user?.userId,
      { status: (item as any).status }).catch(() => {});
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await getCustomerById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'customers'));
    const item = await updateCustomer(req.params.id, req.tenantId!, req.body, resolveEffectiveScope(req, 'customers'));
    if (!item) return sendError(res, 'Customer not found', 404);
    const statusChanged = req.body.status && prev && (prev as any).status !== req.body.status;
    logTimeline(
      req.tenantId!, 'customer', String((item as any)._id), statusChanged ? 'status_changed' : 'updated',
      statusChanged ? `Status changed to ${req.body.status}` : `Customer "${(item as any).name}" updated`,
      req.user?.userId,
      statusChanged ? { previousStatus: (prev as any).status, newStatus: req.body.status } : undefined,
    ).catch(() => {});
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteCustomer(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'customers'));
    if (!item) return sendError(res, 'Customer not found', 404);
    logTimeline(req.tenantId!, 'customer', req.params.id, 'deleted', `Customer "${(item as any).name}" deleted`, req.user?.userId).catch(() => {});
    logAuditEvent('customer.deleted',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'Customer', targetId: req.params.id, detail: { before: { name: (item as any).name } } },
    );
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await getCustomerStats(req.tenantId!, resolveEffectiveScope(req, 'customers'))); }
  catch (err: any) { sendError(res, err.message, 500); }
}
