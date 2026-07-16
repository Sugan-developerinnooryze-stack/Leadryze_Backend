import { Router } from 'express';
import * as ctrl from './part.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createPartSchema, updatePartSchema } from './part.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createPartSchema }),                            ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updatePartSchema }),           ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
