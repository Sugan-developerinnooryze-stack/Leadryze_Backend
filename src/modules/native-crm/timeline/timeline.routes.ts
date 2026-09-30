import { Router } from 'express';
import * as ctrl from './timeline.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

// Tenant-wide feed — deliberately no single requirePermission() gate, see
// the controller's own doc comment for why (authenticate/requireTenant are
// already applied at the parent native-crm.router.ts level, same as every
// sibling route in this file). Per-entry filtering is the actual access
// control here. Registered before the /:module/:entityId route below so
// 'recent' can never be swallowed as a :module value (Express matches
// routes in registration order).
router.get('/recent', ctrl.recent);

router.get('/:module/:entityId', requirePermission('timeline.view'), ctrl.list);

export default router;
