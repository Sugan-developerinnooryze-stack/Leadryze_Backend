import { Router } from 'express';
import * as ctrl from './category.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCategorySchema, updateCategorySchema } from './category.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.categories.view'), ctrl.list);
router.post('/', requirePermission('fs.categories.create'), validate({ body: createCategorySchema }),                        ctrl.create);
router.get('/:id', requirePermission('fs.categories.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.categories.edit'), validate({ params: idParam, body: updateCategorySchema }),       ctrl.update);
router.delete('/:id', requirePermission('fs.categories.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
