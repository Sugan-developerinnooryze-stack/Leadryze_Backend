import { Router } from 'express';
import * as ctrl from './service.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createServiceSchema, updateServiceSchema } from './service.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.services.view'), ctrl.list);
router.post('/', requirePermission('fs.services.create'), validate({ body: createServiceSchema }),                         ctrl.create);
router.get('/:id', requirePermission('fs.services.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.services.edit'), validate({ params: idParam, body: updateServiceSchema }),        ctrl.update);
router.delete('/:id', requirePermission('fs.services.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
