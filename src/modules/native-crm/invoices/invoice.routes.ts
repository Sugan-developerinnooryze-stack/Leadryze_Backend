import { Router } from 'express';
import * as ctrl from './invoice.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createInvoiceSchema, updateInvoiceSchema } from './invoice.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();

router.get('/',       requirePermission('fs.invoices.view'),   ctrl.list);
router.post('/',      requirePermission('fs.invoices.create'), validate({ body: createInvoiceSchema }),                       ctrl.create);
router.get('/:id',    requirePermission('fs.invoices.view'),   validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',    requirePermission('fs.invoices.edit'),   validate({ params: idParam, body: updateInvoiceSchema }),      requireUnlocked('invoices'), ctrl.update);
router.delete('/:id', requirePermission('fs.invoices.delete'), validate({ params: idParam }),                                  requireUnlocked('invoices'), ctrl.remove);

export default router;
