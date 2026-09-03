import { Router } from 'express';
import * as ctrl from './automation-rule.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAutomationRuleSchema, updateAutomationRuleSchema } from './automation-rule.validation';

const router = Router();

// "Simple Mode" — shares the same automation.* permission tier as Advanced
// Mode (automation-flow.routes.ts): a rule can send messages and create/
// mutate records same as a flow can, so it's gated the same way (delete is
// Admin-only, matching Flows' own posture, not Manager's day-to-day tier).
router.get('/',       requirePermission('automation.view'), ctrl.list);
router.get('/target-fields', requirePermission('automation.view'), ctrl.targetFields);
router.post('/',      requirePermission('automation.create'), validate({ body: createAutomationRuleSchema }), ctrl.create);
router.put('/:id',    requirePermission('automation.edit'), validate({ params: idParam, body: updateAutomationRuleSchema }), ctrl.update);
router.delete('/:id', requirePermission('automation.delete'), validate({ params: idParam }), ctrl.remove);

export default router;
