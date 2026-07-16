import { Router } from 'express';
import * as ctrl from './lead.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createLeadSchema, updateLeadSchema, updateStageSchema } from './lead.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();

router.get('/',                 ctrl.list);
router.get('/stats',            ctrl.stats);
router.post('/',                validate({ body: createLeadSchema }), ctrl.create);
router.get('/:id',              validate({ params: idParam }),        ctrl.getOne);
router.put('/:id',              validate({ params: idParam, body: updateLeadSchema }), requireUnlocked('leads'), ctrl.update);
router.delete('/:id',           validate({ params: idParam }),        requireUnlocked('leads'), ctrl.remove);
router.post('/:id/convert/contact',     validate({ params: idParam }), ctrl.convertToContact);
router.post('/:id/convert/opportunity', validate({ params: idParam }), ctrl.convertToOpportunity);
router.post('/:id/convert/customer',    validate({ params: idParam }), ctrl.convertToCustomer);
router.get('/:id/conversions',          validate({ params: idParam }), ctrl.getConversions);
router.post('/:id/convert',     validate({ params: idParam }),        ctrl.convertLead);
router.patch('/:id/stage',      validate({ params: idParam, body: updateStageSchema }), ctrl.updateStage);

export default router;
