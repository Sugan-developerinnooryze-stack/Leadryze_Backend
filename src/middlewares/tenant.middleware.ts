import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { sendError } from '../utils/response';
import { Tenant } from '../modules/tenants/tenant.model';
import { getEffectiveFeatureFlags } from '../modules/tenants/tenant.service';

export async function requireTenant(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user?.tenantId) {
    sendError(res, 'Tenant context required', 400);
    return;
  }

  // Deactivated tenants stop working immediately, even on an already-issued
  // JWT — Super Admin is exempt (same reasoning as loginUser's check: never
  // lock out the account that manages this flag). Widened to also pull
  // featureFlags/accessConfigMode here (not a second query later) — every
  // tenant-scoped request already pays for this lookup, requireModuleEnabled
  // just reads what's attached below instead of fetching it again.
  if (req.user.role !== 'SUPER_ADMIN') {
    const tenant = await Tenant.findById(req.user.tenantId).select('isActive featureFlags accessConfigMode').lean();
    if (tenant && !tenant.isActive) {
      sendError(res, "Your organization's account has been deactivated. Contact support.", 403);
      return;
    }
    if (tenant) req.featureFlags = await getEffectiveFeatureFlags(tenant) as unknown as Record<string, boolean>;
  }

  req.tenantId = req.user.tenantId;
  next();
}
