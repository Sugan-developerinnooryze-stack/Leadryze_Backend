import { Router } from 'express';
import * as ctrl from './category.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCategorySchema, updateCategorySchema } from './category.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createCategorySchema }),                        ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateCategorySchema }),       ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
