import { Router } from 'express';
import * as ctrl from './product.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createProductSchema, updateProductSchema } from './product.validation';

const router = Router();
router.get('/',       ctrl.list);
router.post('/',      validate({ body: createProductSchema }),                         ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateProductSchema }),        ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);
export default router;
