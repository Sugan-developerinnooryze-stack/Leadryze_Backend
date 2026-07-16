import { Router } from 'express';
import * as ctrl from './timeline.controller';

const router = Router();

router.get('/:module/:entityId', ctrl.list);

export default router;
