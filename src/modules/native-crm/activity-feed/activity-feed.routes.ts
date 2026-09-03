import { Router } from 'express';
import * as ctrl from './activity-feed.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { activityFeedQuerySchema } from './activity-feed.validation';

const router = Router();
router.get('/', requirePermission('activity_feed.view'), validate({ query: activityFeedQuerySchema }), ctrl.list);

export default router;
