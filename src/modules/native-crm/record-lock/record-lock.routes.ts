import { Router } from 'express';
import { requirePermission } from '../../../middlewares/auth.middleware';
import * as ctrl from './record-lock.controller';

const router = Router();

// Tenant-wide audit log — was "any authenticated user in tenant" per the
// old comment; now requires record_lock.view, granted broadly (Manager +
// Agent) since the old behavior was effectively equivalent already.
router.get('/audit', requirePermission('record_lock.view'), ctrl.tenantAudit);

// Per-record endpoints
router.get('/:module/:id/status', requirePermission('record_lock.view'), ctrl.status);
router.get('/:module/:id/audit',  requirePermission('record_lock.view'), ctrl.audit);

// Admin-only lock/unlock
router.post('/:module/:id/lock',   requirePermission('record_lock.manage'), ctrl.lock);
router.post('/:module/:id/unlock', requirePermission('record_lock.manage'), ctrl.unlock);

export default router;
