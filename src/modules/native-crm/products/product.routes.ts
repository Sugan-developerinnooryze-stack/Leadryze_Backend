import { Router } from 'express';
import * as ctrl from './product.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createProductSchema, updateProductSchema } from './product.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('fs.products.view'), ctrl.list);
router.post('/', requirePermission('fs.products.create'), validate({ body: createProductSchema }),                         ctrl.create);
router.get('/:id', requirePermission('fs.products.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.products.edit'), validate({ params: idParam, body: updateProductSchema }),        ctrl.update);
router.delete('/:id', requirePermission('fs.products.delete'), validate({ params: idParam }),                                   ctrl.remove);
export default router;
