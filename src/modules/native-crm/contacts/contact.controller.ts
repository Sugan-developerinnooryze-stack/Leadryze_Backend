import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './contact.service';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'contacts')?.viewRoles ?? [];
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status } = req.query as Record<string, string>;
    const result = await svc.listContacts(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
    }, req.branchId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(result.items, 'contacts', req.user!.role, viewRoles);
    sendSuccess(res, safeItems, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch contacts', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getContactById(req.tenantId!, req.params.id);
    if (!record) return void sendError(res, 'Contact not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(record, 'contacts', req.user!.role, viewRoles));
  } catch { sendError(res, 'Failed to fetch contact', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createContact(req.tenantId!, { ...req.body, branchId: req.body.branchId ?? req.branchId ?? null });
    sendCreated(res, record, 'Contact created');
  } catch { sendError(res, 'Failed to create contact', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateContact(req.tenantId!, req.params.id, req.body);
    if (!record) return void sendError(res, 'Contact not found', 404);
    sendSuccess(res, record, 'Contact updated');
  } catch { sendError(res, 'Failed to update contact', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteContact(req.tenantId!, req.params.id);
    if (!ok) return void sendError(res, 'Contact not found', 404);
    sendSuccess(res, null, 'Contact deleted');
  } catch { sendError(res, 'Failed to delete contact', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getContactStats(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
