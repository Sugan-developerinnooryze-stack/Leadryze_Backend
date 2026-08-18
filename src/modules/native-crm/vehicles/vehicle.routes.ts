import { Router } from 'express';
import * as ctrl from './vehicle.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createVehicleSchema, updateVehicleSchema } from './vehicle.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('fs.vehicles.view'), ctrl.list);
router.post('/', requirePermission('fs.vehicles.create'), validate({ body: createVehicleSchema }),                         ctrl.create);
router.get('/:id', requirePermission('fs.vehicles.view'), validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id', requirePermission('fs.vehicles.edit'), validate({ params: idParam, body: updateVehicleSchema }),        ctrl.update);
router.delete('/:id', requirePermission('fs.vehicles.delete'), validate({ params: idParam }),                                   ctrl.remove);
export default router;
