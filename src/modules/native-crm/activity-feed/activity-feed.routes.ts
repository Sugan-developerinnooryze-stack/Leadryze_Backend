import { Router } from 'express';
import * as ctrl from './activity-feed.controller';
import { validate } from '../../../middleware/validate.middleware';
import { activityFeedQuerySchema } from './activity-feed.validation';

const router = Router();
router.get('/', validate({ query: activityFeedQuerySchema }), ctrl.list);

export default router;
