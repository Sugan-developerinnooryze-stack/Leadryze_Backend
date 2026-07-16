import { Router } from 'express';
import { authorize } from '../../../middlewares/auth.middleware';
import * as ctrl from './record-lock.controller';

const router = Router();

// Tenant-wide audit log — any authenticated user in tenant
router.get('/audit', ctrl.tenantAudit);

// Per-record endpoints
router.get('/:module/:id/status', ctrl.status);
router.get('/:module/:id/audit',  ctrl.audit);

// Admin-only lock/unlock
router.post('/:module/:id/lock',   authorize('SUPER_ADMIN', 'TENANT_ADMIN'), ctrl.lock);
router.post('/:module/:id/unlock', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), ctrl.unlock);

export default router;
