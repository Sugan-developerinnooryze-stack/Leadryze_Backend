import { Router } from 'express';
import * as ctrl from './workorder.controller';
import { upload } from '../../../middlewares/upload.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createWorkorderSchema, updateWorkorderSchema } from './workorder.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();

router.get('/staff-availability', requirePermission('fs.workorders.view'), ctrl.staffAvailability);
router.get('/nearest-staff',     requirePermission('fs.workorders.view'), ctrl.nearestStaff);
router.get('/',       requirePermission('fs.workorders.view'),   ctrl.list);
router.post('/',      requirePermission('fs.workorders.create'), validate({ body: createWorkorderSchema }), ctrl.create);
router.get('/:id',    requirePermission('fs.workorders.view'),   validate({ params: idParam }),              ctrl.getOne);
router.put('/:id',    requirePermission('fs.workorders.edit'),   validate({ params: idParam, body: updateWorkorderSchema }), requireUnlocked('workorders'), ctrl.update);
router.delete('/:id', requirePermission('fs.workorders.delete'), validate({ params: idParam }),              requireUnlocked('workorders'), ctrl.remove);
router.post('/:id/upload', requirePermission('fs.workorders.edit'),
  upload.fields([{ name: 'photos', maxCount: 10 }, { name: 'signature', maxCount: 1 }]),
  ctrl.uploadFiles);

export default router;
