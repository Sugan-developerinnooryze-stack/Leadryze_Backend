import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import { listSites, getSiteById, createSite, updateSite, deleteSite } from './site.service';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'sites')?.viewRoles ?? [];
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listSites(req.tenantId!, req.query as any, req.branchId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(items, 'sites', req.user!.role, viewRoles);
    sendPaginated(res, safeItems, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getSiteById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Site not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(item, 'sites', req.user!.role, viewRoles));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createSite({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateSite(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Site not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteSite(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Site not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
