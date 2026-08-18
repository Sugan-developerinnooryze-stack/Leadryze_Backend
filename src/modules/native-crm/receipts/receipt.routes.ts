import { Router } from 'express';
import * as ctrl from './receipt.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createReceiptSchema, updateReceiptSchema } from './receipt.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.receipts.view'), ctrl.list);
router.post('/', requirePermission('fs.receipts.create'), validate({ body: createReceiptSchema }),                         ctrl.create);
router.get('/:id', requirePermission('fs.receipts.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.receipts.edit'), validate({ params: idParam, body: updateReceiptSchema }),        ctrl.update);
router.delete('/:id', requirePermission('fs.receipts.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
