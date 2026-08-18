import { Router } from 'express';
import * as ctrl from './call.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCallSchema, updateCallSchema } from './call.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.calls.view'), ctrl.list);
router.post('/', requirePermission('native_crm.calls.create'), validate({ body: createCallSchema }),                           ctrl.create);
router.get('/stats', requirePermission('native_crm.calls.view'), ctrl.stats);
router.get('/:id', requirePermission('native_crm.calls.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.calls.edit'), validate({ params: idParam, body: updateCallSchema }),          ctrl.update);
router.delete('/:id', requirePermission('native_crm.calls.delete'), validate({ params: idParam }),                                  ctrl.remove);

export default router;
