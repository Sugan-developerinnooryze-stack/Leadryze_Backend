import { Router } from 'express';
import * as ctrl from './email-log.controller';

const router = Router();
router.get('/', ctrl.list);

export default router;
