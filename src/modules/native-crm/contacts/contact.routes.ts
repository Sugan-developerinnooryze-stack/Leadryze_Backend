import { Router } from 'express';
import * as ctrl from './contact.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createContactSchema, updateContactSchema } from './contact.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();
router.get('/',        ctrl.list);
router.post('/',       validate({ body: createContactSchema }),                        ctrl.create);
router.get('/stats',   ctrl.stats);
router.get('/:id',     validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',     validate({ params: idParam, body: updateContactSchema }),       requireUnlocked('contacts'), ctrl.update);
router.delete('/:id',  validate({ params: idParam }),                                  requireUnlocked('contacts'), ctrl.remove);

export default router;
