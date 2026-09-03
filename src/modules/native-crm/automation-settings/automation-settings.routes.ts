import { Router } from 'express';
import * as ctrl from './automation-settings.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/',   requirePermission('automation.view'),            ctrl.get);
router.patch('/', requirePermission('automation.manage_settings'), ctrl.update);

export default router;
