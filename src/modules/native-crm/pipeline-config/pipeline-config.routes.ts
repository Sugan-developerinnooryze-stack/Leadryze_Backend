import { Router } from 'express';
import * as ctrl from './pipeline-config.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/:module', requirePermission('pipeline_config.view'),   ctrl.getStages);
router.put('/:module', requirePermission('pipeline_config.manage'), ctrl.putStages);

export default router;
