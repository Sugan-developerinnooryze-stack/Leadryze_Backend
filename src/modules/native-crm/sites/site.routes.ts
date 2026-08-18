import { Router } from 'express';
import * as ctrl from './site.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createSiteSchema, updateSiteSchema } from './site.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/', requirePermission('fs.sites.view'), ctrl.list);
router.post('/', requirePermission('fs.sites.create'), validate({ body: createSiteSchema }),                            ctrl.create);
router.get('/:id', requirePermission('fs.sites.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.sites.edit'), validate({ params: idParam, body: updateSiteSchema }),           ctrl.update);
router.delete('/:id', requirePermission('fs.sites.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
