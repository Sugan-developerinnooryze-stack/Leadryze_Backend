import { Router } from 'express';
import * as ctrl from './expense.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createExpenseSchema, updateExpenseSchema } from './expense.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.expenses.view'), ctrl.list);
router.post('/', requirePermission('fs.expenses.create'), validate({ body: createExpenseSchema }),                         ctrl.create);
router.get('/:id', requirePermission('fs.expenses.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.expenses.edit'), validate({ params: idParam, body: updateExpenseSchema }),        ctrl.update);
router.delete('/:id', requirePermission('fs.expenses.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
