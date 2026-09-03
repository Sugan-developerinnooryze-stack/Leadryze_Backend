import { Router } from 'express';
import * as ctrl from './notification-settings.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('notification_settings.view'),   ctrl.get);
router.put('/', requirePermission('notification_settings.manage'), ctrl.update);

export default router;
