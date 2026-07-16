import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as tenantService from './tenant.service';
import { sendSuccess, sendCreated, sendError, sendPaginated } from '../../utils/response';

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
    const tenant = await tenantService.updateTenant(req.params.id, req.body);
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, tenant, 'Tenant updated');
  } catch (err) { next(err); }
}

export async function deleteTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await tenantService.deleteTenant(req.params.id);
    sendSuccess(res, null, 'Tenant deactivated');
  } catch (err) { next(err); }
}
