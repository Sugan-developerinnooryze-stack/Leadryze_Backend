import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as tenantService from './tenant.service';
import { sendSuccess, sendCreated, sendError, sendPaginated } from '../../utils/response';
import { Tenant } from './tenant.model';
import { logAuditEvent } from '../logs/audit-log.model';

export async function createTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantService.createTenant(req.body);
    sendCreated(res, tenant, 'Tenant created');
  } catch (err) { next(err); }
}

export async function getTenants(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { tenants, total, page, limit } = await tenantService.getTenants(req.query as Record<string, unknown>);
    sendPaginated(res, tenants, total, page, limit);
  } catch (err) { next(err); }
}

export async function getTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantService.getTenantById(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, tenant);
  } catch (err) { next(err); }
}

export async function updateTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Snapshot only the top-level keys the caller is touching, so the audit
    // entry below can show old vs. new without a second full-document read.
    const changedKeys = Object.keys(req.body ?? {});
    const before = changedKeys.length
      ? await Tenant.findById(req.params.id).select(changedKeys.join(' ')).lean()
      : null;

    const tenant = await tenantService.updateTenant(req.params.id, req.body);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    if (before) {
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const key of changedKeys) {
        oldValues[key] = (before as unknown as Record<string, unknown>)[key];
        newValues[key] = (tenant as unknown as Record<string, unknown>)[key];
      }
      logAuditEvent(
        'tenant.updated',
        { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
        { tenantId: req.params.id, target: 'Tenant', targetId: req.params.id, detail: { tenantName: tenant.name, changedFields: changedKeys, oldValues, newValues } },
      );
    }

    sendSuccess(res, tenant, 'Tenant updated');
  } catch (err) { next(err); }
}

export async function deleteTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await tenantService.deleteTenant(req.params.id);
    sendSuccess(res, null, 'Tenant deactivated');
  } catch (err) { next(err); }
}

export async function regenerateWidgetKey(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantService.regenerateWidgetKey(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, { widgetKey: tenant.widget?.widgetKey }, 'Widget key regenerated');
  } catch (err) { next(err); }
}

export async function uploadWidgetLogo(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) { sendError(res, 'file is required', 400); return; }
    const tenant = await tenantService.uploadWidgetLogo(req.params.id, {
      originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer,
    });
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, { logoUrl: tenant.widget?.logoUrl }, 'Widget logo uploaded');
  } catch (err) { next(err); }
}

export async function removeWidgetLogo(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantService.removeWidgetLogo(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, null, 'Widget logo removed');
  } catch (err) { next(err); }
}

export async function uploadWidgetBackgroundImage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) { sendError(res, 'file is required', 400); return; }
    const tenant = await tenantService.uploadWidgetBackgroundImage(req.params.id, {
      originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer,
    });
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, { backgroundImageUrl: tenant.widget?.theme?.backgroundImageUrl }, 'Background image uploaded');
  } catch (err) { next(err); }
}

export async function removeWidgetBackgroundImage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantService.removeWidgetBackgroundImage(req.params.id);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, null, 'Background image removed');
  } catch (err) { next(err); }
}

export async function getAiUsage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const usage = await tenantService.getAiUsage(req.params.id);
    if (!usage) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, usage);
  } catch (err) { next(err); }
}
