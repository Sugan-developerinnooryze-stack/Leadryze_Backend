import { Router } from 'express';
import * as ctrl from './expense.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createExpenseSchema, updateExpenseSchema } from './expense.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createExpenseSchema }),                         ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateExpenseSchema }),        ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
