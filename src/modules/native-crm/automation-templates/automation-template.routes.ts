import { Router } from 'express';
import * as ctrl from './automation-template.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAutomationTemplateSchema } from './automation-template.validation';

const router = Router();

// Same automation.* tier both engines already use — browsing/instantiating
// a template is no more powerful than authoring a flow directly, so no new
// RBAC permission is introduced.
router.get('/',       requirePermission('automation.view'), ctrl.list);
router.get('/:id',    requirePermission('automation.view'), validate({ params: idParam }), ctrl.getOne);
router.post('/',      requirePermission('automation.create'), validate({ body: createAutomationTemplateSchema }), ctrl.create);
router.delete('/:id', requirePermission('automation.edit'), validate({ params: idParam }), ctrl.remove);

export default router;
