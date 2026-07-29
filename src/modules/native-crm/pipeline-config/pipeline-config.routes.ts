import { Router } from 'express';
import * as ctrl from './pipeline-config.controller';

const router = Router();
router.get('/:module', ctrl.getStages);
router.put('/:module', ctrl.putStages);

export default router;
