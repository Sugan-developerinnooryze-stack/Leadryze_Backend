import { Router } from 'express';
import * as ctrl from './quotation.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createQuotationSchema, updateQuotationSchema } from './quotation.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();

router.get('/',       requirePermission('fs.quotations.view'),   ctrl.list);
router.post('/',      requirePermission('fs.quotations.create'), validate({ body: createQuotationSchema }),                    ctrl.create);
router.get('/:id',    requirePermission('fs.quotations.view'),   validate({ params: idParam }),                                ctrl.getOne);
router.put('/:id',    requirePermission('fs.quotations.edit'),   validate({ params: idParam, body: updateQuotationSchema }),  requireUnlocked('quotations'), ctrl.update);
router.delete('/:id', requirePermission('fs.quotations.delete'), validate({ params: idParam }),                                requireUnlocked('quotations'), ctrl.remove);

export default router;
