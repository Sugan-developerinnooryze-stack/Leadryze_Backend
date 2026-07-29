import { Router } from 'express';
import * as ctrl from './automation-rule.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAutomationRuleSchema, updateAutomationRuleSchema } from './automation-rule.validation';

const router = Router();

router.get('/',       ctrl.list);
router.get('/target-fields', ctrl.targetFields);
router.post('/',      validate({ body: createAutomationRuleSchema }), ctrl.create);
router.put('/:id',    validate({ params: idParam, body: updateAutomationRuleSchema }), ctrl.update);
router.delete('/:id', validate({ params: idParam }), ctrl.remove);

export default router;
