import { Router } from 'express';
import * as ctrl from './site.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createSiteSchema, updateSiteSchema } from './site.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createSiteSchema }),                            ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateSiteSchema }),           ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
