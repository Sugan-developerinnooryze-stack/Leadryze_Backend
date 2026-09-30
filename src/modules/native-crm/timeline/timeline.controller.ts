import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getTimeline, getRecentTenantTimeline } from './timeline.service';
import { ENTITY_MODULE_ACCESS } from '../shared/module-access-map';
import { hasPermission } from '../../rbac/permission.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { module, entityId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const items = await getTimeline(tenantId, module, entityId, limit);
    return sendSuccess(res, items);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}

/** No single requirePermission() gate — this endpoint spans many
 * permission domains at once, so it computes a personalized subset of
 * entityModule values per request instead (same double-gate rule as
 * everywhere else on the dashboard: tenant feature flag AND permission,
 * both checked, per module — never permission alone). SUPER_ADMIN/
 * TENANT_ADMIN bypass exactly like requirePermission's own middleware does. */
export async function recent(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { role, roleId } = req.user ?? {};
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

    const isFullAccess = role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN';
    const entries = Object.entries(ENTITY_MODULE_ACCESS);
    const allowedModules: string[] = [];

    for (const [module, { permission, flag }] of entries) {
      if (req.featureFlags?.[flag] === false) continue;
      if (isFullAccess) { allowedModules.push(module); continue; }
      if (!roleId) continue;
      if (await hasPermission(tenantId, roleId, permission)) allowedModules.push(module);
    }

    const items = await getRecentTenantTimeline(tenantId, allowedModules, limit);
    return sendSuccess(res, items);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}
