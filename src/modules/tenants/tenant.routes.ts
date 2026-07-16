import { Router, Response, NextFunction } from 'express';
import * as controller from './tenant.controller';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { AuthRequest } from '../../types';
import { Tenant, DEFAULT_FEATURE_FLAGS } from './tenant.model';
import { sendSuccess, sendError } from '../../utils/response';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { logSecurityEvent } from '../logs/security-event.model';

const router = Router();

router.use(authenticate);

// Ownership guard — TENANT_ADMIN can only access their own tenant record
function requireOwnTenant(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role === 'SUPER_ADMIN') { next(); return; }
  if (req.params.id !== req.user?.tenantId) {
    logSecurityEvent('tenant.access_denied', {
      tenantId:  req.user?.tenantId,
      userId:    req.user?.userId,
      ip:        req.ip ?? 'unknown',
      userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
      detail:    { requestedTenantId: req.params.id },
    });
    sendError(res, 'Access denied', 403);
    return;
  }
  next();
}

// GET /tenants/features — returns feature flags for the caller's tenant (any authenticated user)
router.get('/features', requireTenant, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await Tenant.findById(req.tenantId).select('featureFlags');
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }
    sendSuccess(res, { ...DEFAULT_FEATURE_FLAGS, ...(tenant.featureFlags ?? {}) });
  } catch (err) { next(err); }
});

router.post('/', authorize('SUPER_ADMIN'), controller.createTenant);
router.get('/', authorize('SUPER_ADMIN'), controller.getTenants);
router.get('/:id', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), requireOwnTenant, controller.getTenant);
router.put('/:id', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), requireOwnTenant, controller.updateTenant);
router.delete('/:id', authorize('SUPER_ADMIN'), controller.deleteTenant);

export default router;
