import { Router } from 'express';
import * as ctrl from './activity.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createActivitySchema, updateActivitySchema } from './activity.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.activities.view'), ctrl.list);
router.post('/', requirePermission('fs.activities.create'), validate({ body: createActivitySchema }),                        ctrl.create);
router.get('/:id', requirePermission('fs.activities.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.activities.edit'), validate({ params: idParam, body: updateActivitySchema }),       ctrl.update);
router.delete('/:id', requirePermission('fs.activities.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
