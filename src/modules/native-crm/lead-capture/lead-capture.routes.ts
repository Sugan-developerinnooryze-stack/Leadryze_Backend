import { Router } from 'express';
import * as ctrl from './lead-capture.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { createLeadCaptureSchema, listLeadCaptureQuerySchema } from './lead-capture.validation';

const router = Router();
// Reuses the Leads tier — a capture record is a pre-Lead record on the same
// pipeline, not a separate concern with its own permission key.
router.post('/', requirePermission('native_crm.leads.create'), validate({ body: createLeadCaptureSchema }), ctrl.create);
router.get('/',  requirePermission('native_crm.leads.view'),   validate({ query: listLeadCaptureQuerySchema }), ctrl.list);

export default router;
