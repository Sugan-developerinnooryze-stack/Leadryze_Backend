import { Router } from 'express';
import * as ctrl from './staff.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createStaffSchema, updateStaffSchema } from './staff.validation';
import { makeCredentialHandlers, credentialsUpdateSchema } from '../shared/app-credentials.controller';
import { NativeStaff } from './staff.model';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

const cred = makeCredentialHandlers(NativeStaff, (d) => d.firstName ?? '');

router.get('/',              requirePermission('fs.staffs.view'),   ctrl.list);
router.post('/',             requirePermission('fs.staffs.create'), validate({ body: createStaffSchema }),                            ctrl.create);
router.put('/:id/location',  requirePermission('fs.staffs.edit'),   validate({ params: idParam }),                                    ctrl.updateLocation);
router.get('/:id/credentials',              requirePermission('fs.staffs.edit'), validate({ params: idParam }),                                  cred.getCredentials);
router.patch('/:id/credentials',            requirePermission('fs.staffs.edit'), validate({ params: idParam, body: credentialsUpdateSchema }),   cred.updateCredentials);
router.post('/:id/credentials/regenerate',  requirePermission('fs.staffs.edit'), validate({ params: idParam }),                                  cred.regeneratePassword);
router.get('/:id',           requirePermission('fs.staffs.view'),   validate({ params: idParam }),                                    ctrl.getOne);
router.put('/:id',           requirePermission('fs.staffs.edit'),   validate({ params: idParam, body: updateStaffSchema }),           ctrl.update);
router.delete('/:id',        requirePermission('fs.staffs.delete'), validate({ params: idParam }),                                    ctrl.remove);

export default router;
