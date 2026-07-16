import { Router } from 'express';
import * as ctrl from './company.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCompanySchema, updateCompanySchema } from './company.validation';

const router = Router();
router.get('/',        ctrl.list);
router.post('/',       validate({ body: createCompanySchema }),                        ctrl.create);
router.get('/stats',   ctrl.stats);
router.get('/:id',     validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',     validate({ params: idParam, body: updateCompanySchema }),       ctrl.update);
router.delete('/:id',  validate({ params: idParam }),                                  ctrl.remove);

export default router;
