import { Router } from 'express';
import * as ctrl from './receipt.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createReceiptSchema, updateReceiptSchema } from './receipt.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createReceiptSchema }),                         ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateReceiptSchema }),        ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
