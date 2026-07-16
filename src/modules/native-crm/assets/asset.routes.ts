import { Router } from 'express';
import * as ctrl from './asset.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAssetSchema, updateAssetSchema } from './asset.validation';

const router = Router();
router.get('/',       ctrl.list);
router.post('/',      validate({ body: createAssetSchema }),                           ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateAssetSchema }),          ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);
export default router;
