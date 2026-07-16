import { Router } from 'express';
import * as ctrl from './customer.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCustomerSchema, updateCustomerSchema } from './customer.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';
import { makeCredentialHandlers, credentialsUpdateSchema } from '../shared/app-credentials.controller';
import { NativeCustomer } from './customer.model';

const router = Router();

const cred = makeCredentialHandlers(NativeCustomer, (d) => d.name ?? '');

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createCustomerSchema }),                        ctrl.create);
router.get('/:id/credentials',              validate({ params: idParam }),                                cred.getCredentials);
router.patch('/:id/credentials',            validate({ params: idParam, body: credentialsUpdateSchema }), cred.updateCredentials);
router.post('/:id/credentials/regenerate',  validate({ params: idParam }),                                cred.regeneratePassword);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateCustomerSchema }),       requireUnlocked('customers'), ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   requireUnlocked('customers'), ctrl.remove);

export default router;
