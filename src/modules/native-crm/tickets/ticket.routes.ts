import { Router } from 'express';
import * as ctrl from './ticket.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createTicketSchema, updateTicketSchema } from './ticket.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.tickets.view'), ctrl.list);
router.post('/', requirePermission('native_crm.tickets.create'), validate({ body: createTicketSchema }),                         ctrl.create);
router.get('/stats', requirePermission('native_crm.tickets.view'), ctrl.stats);
router.get('/:id', requirePermission('native_crm.tickets.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.tickets.edit'), validate({ params: idParam, body: updateTicketSchema }),        ctrl.update);
router.delete('/:id', requirePermission('native_crm.tickets.delete'), validate({ params: idParam }),                                  ctrl.remove);

export default router;
