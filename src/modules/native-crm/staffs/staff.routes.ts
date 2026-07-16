import { Router } from 'express';
import * as ctrl from './staff.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createStaffSchema, updateStaffSchema } from './staff.validation';
import { makeCredentialHandlers, credentialsUpdateSchema } from '../shared/app-credentials.controller';
import { NativeStaff } from './staff.model';

const router = Router();

const cred = makeCredentialHandlers(NativeStaff, (d) => d.firstName ?? '');

router.get('/',              ctrl.list);
router.post('/',             validate({ body: createStaffSchema }),                            ctrl.create);
router.put('/:id/location',  validate({ params: idParam }),                                    ctrl.updateLocation);
router.get('/:id/credentials',              validate({ params: idParam }),                                  cred.getCredentials);
router.patch('/:id/credentials',            validate({ params: idParam, body: credentialsUpdateSchema }),   cred.updateCredentials);
router.post('/:id/credentials/regenerate',  validate({ params: idParam }),                                  cred.regeneratePassword);
router.get('/:id',           validate({ params: idParam }),                                    ctrl.getOne);
router.put('/:id',           validate({ params: idParam, body: updateStaffSchema }),           ctrl.update);
router.delete('/:id',        validate({ params: idParam }),                                    ctrl.remove);

export default router;
