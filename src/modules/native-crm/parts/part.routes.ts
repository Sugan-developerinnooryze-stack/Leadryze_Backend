import { Router } from 'express';
import * as ctrl from './part.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createPartSchema, updatePartSchema } from './part.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.parts.view'), ctrl.list);
router.post('/', requirePermission('fs.parts.create'), validate({ body: createPartSchema }),                            ctrl.create);
router.get('/:id', requirePermission('fs.parts.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.parts.edit'), validate({ params: idParam, body: updatePartSchema }),           ctrl.update);
router.delete('/:id', requirePermission('fs.parts.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
