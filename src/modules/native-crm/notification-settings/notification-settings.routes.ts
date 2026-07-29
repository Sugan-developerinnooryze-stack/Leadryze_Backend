import { Router } from 'express';
import * as ctrl from './notification-settings.controller';

const router = Router();
router.get('/', ctrl.get);
router.put('/', ctrl.update);

export default router;
