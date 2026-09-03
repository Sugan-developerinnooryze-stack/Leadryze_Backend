import { Router } from 'express';
import * as ctrl from './ticket-sla-policy.controller';
import { validate } from '../../../middleware/validate.middleware';
import { updateSlaPolicySchema } from './ticket-sla-policy.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.tickets.manage_sla'), ctrl.get);
router.put('/', requirePermission('native_crm.tickets.manage_sla'), validate({ body: updateSlaPolicySchema }), ctrl.update);

export default router;
