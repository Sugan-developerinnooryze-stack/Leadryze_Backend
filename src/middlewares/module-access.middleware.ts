import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { sendError } from '../utils/response';

/** Real, server-side module gating — the counterpart to Sidebar.tsx hiding
 * a nav item. A hidden link is not access control by itself; this is what
 * makes it one. Mount directly at each sub-router in native-crm.router.ts,
 * e.g. `router.use('/quotations', requireModuleEnabled('fs_quotations'), quotationRoutes)`.
 *
 * Reads req.featureFlags, which requireTenant() already resolved (through
 * accessConfigMode) and attached — no extra DB query here. SUPER_ADMIN
 * always bypasses, matching every other tenant-scoped gate in this codebase
 * (requireTenant's own isActive check, assertTenantLoginAllowed, etc). */
export function requireModuleEnabled(flagKey: string) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (req.user?.role === 'SUPER_ADMIN') { next(); return; }
    if (req.featureFlags?.[flagKey] === false) {
      sendError(res, 'This module is not enabled for your account. Contact your administrator.', 403);
      return;
    }
    next();
  };
}
