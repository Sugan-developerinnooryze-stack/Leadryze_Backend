import { Router } from 'express';
import * as ctrl from './contact.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createContactSchema, updateContactSchema } from './contact.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.contacts.view'), ctrl.list);
router.post('/', requirePermission('native_crm.contacts.create'), validate({ body: createContactSchema }),                        ctrl.create);
router.get('/stats', requirePermission('native_crm.contacts.view'), ctrl.stats);
router.get('/:id', requirePermission('native_crm.contacts.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.contacts.edit'), validate({ params: idParam, body: updateContactSchema }),       requireUnlocked('contacts'), ctrl.update);
router.delete('/:id', requirePermission('native_crm.contacts.delete'), validate({ params: idParam }),                                  requireUnlocked('contacts'), ctrl.remove);

export default router;
