import { Router } from 'express';
import * as ctrl from './asset.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAssetSchema, updateAssetSchema } from './asset.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('fs.assets.view'), ctrl.list);
router.post('/', requirePermission('fs.assets.create'), validate({ body: createAssetSchema }),                           ctrl.create);
router.get('/:id', requirePermission('fs.assets.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.assets.edit'), validate({ params: idParam, body: updateAssetSchema }),          ctrl.update);
router.delete('/:id', requirePermission('fs.assets.delete'), validate({ params: idParam }),                                   ctrl.remove);
export default router;
