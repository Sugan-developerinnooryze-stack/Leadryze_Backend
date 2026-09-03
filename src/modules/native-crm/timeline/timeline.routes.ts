import { Router } from 'express';
import * as ctrl from './timeline.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/:module/:entityId', requirePermission('timeline.view'), ctrl.list);

export default router;
