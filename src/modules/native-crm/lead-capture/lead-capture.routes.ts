import { Router } from 'express';
import * as ctrl from './lead-capture.controller';
import { validate } from '../../../middleware/validate.middleware';
import { createLeadCaptureSchema, listLeadCaptureQuerySchema } from './lead-capture.validation';

const router = Router();
router.post('/', validate({ body: createLeadCaptureSchema }), ctrl.create);
router.get('/',  validate({ query: listLeadCaptureQuerySchema }), ctrl.list);

export default router;
