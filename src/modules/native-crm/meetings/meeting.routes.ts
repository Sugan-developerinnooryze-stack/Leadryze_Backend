import { Router } from 'express';
import * as ctrl from './meeting.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createMeetingSchema, updateMeetingSchema } from './meeting.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/',        requirePermission('native_crm.meetings.view'),   ctrl.list);
router.post('/',       requirePermission('native_crm.meetings.create'), validate({ body: createMeetingSchema }),                        ctrl.create);
router.get('/stats',   requirePermission('native_crm.meetings.view'),   ctrl.stats);
router.get('/:id',     requirePermission('native_crm.meetings.view'),   validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',     requirePermission('native_crm.meetings.edit'),   validate({ params: idParam, body: updateMeetingSchema }),       ctrl.update);
router.delete('/:id',  requirePermission('native_crm.meetings.delete'), validate({ params: idParam }),                                  ctrl.remove);

export default router;
