import { Router } from 'express';
import * as ctrl from './activity.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createActivitySchema, updateActivitySchema } from './activity.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createActivitySchema }),                        ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateActivitySchema }),       ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
