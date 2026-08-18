import { Router } from 'express';
import * as ctrl from './task.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createTaskSchema, updateTaskSchema } from './task.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.tasks.view'), ctrl.list);
router.post('/', requirePermission('native_crm.tasks.create'), validate({ body: createTaskSchema }),                           ctrl.create);
router.get('/stats', requirePermission('native_crm.tasks.view'), ctrl.stats);
router.get('/:id', requirePermission('native_crm.tasks.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.tasks.edit'), validate({ params: idParam, body: updateTaskSchema }),          ctrl.update);
router.delete('/:id', requirePermission('native_crm.tasks.delete'), validate({ params: idParam }),                                  ctrl.remove);

export default router;
