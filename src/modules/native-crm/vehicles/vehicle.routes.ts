import { Router } from 'express';
import * as ctrl from './vehicle.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createVehicleSchema, updateVehicleSchema } from './vehicle.validation';

const router = Router();
router.get('/',       ctrl.list);
router.post('/',      validate({ body: createVehicleSchema }),                         ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateVehicleSchema }),        ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);
export default router;
