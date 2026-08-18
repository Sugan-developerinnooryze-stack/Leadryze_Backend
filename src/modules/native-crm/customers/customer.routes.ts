import { Router } from 'express';
import * as ctrl from './customer.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCustomerSchema, updateCustomerSchema } from './customer.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';
import { makeCredentialHandlers, credentialsUpdateSchema } from '../shared/app-credentials.controller';
import { NativeCustomer } from './customer.model';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

const cred = makeCredentialHandlers(NativeCustomer, (d) => d.name ?? '');

router.get('/',       requirePermission('fs.customers.view'),   ctrl.list);
router.get('/stats',  requirePermission('fs.customers.view'),   ctrl.stats);
router.post('/',      requirePermission('fs.customers.create'), validate({ body: createCustomerSchema }),                        ctrl.create);
router.get('/:id/credentials',              requirePermission('fs.customers.edit'), validate({ params: idParam }),                                cred.getCredentials);
router.patch('/:id/credentials',            requirePermission('fs.customers.edit'), validate({ params: idParam, body: credentialsUpdateSchema }), cred.updateCredentials);
router.post('/:id/credentials/regenerate',  requirePermission('fs.customers.edit'), validate({ params: idParam }),                                cred.regeneratePassword);
router.get('/:id',    requirePermission('fs.customers.view'),   validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    requirePermission('fs.customers.edit'),   validate({ params: idParam, body: updateCustomerSchema }),       requireUnlocked('customers'), ctrl.update);
router.delete('/:id', requirePermission('fs.customers.delete'), validate({ params: idParam }),                                   requireUnlocked('customers'), ctrl.remove);

export default router;
