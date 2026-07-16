import { Router } from 'express';
import * as ctrl from './service.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createServiceSchema, updateServiceSchema } from './service.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createServiceSchema }),                         ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateServiceSchema }),        ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
