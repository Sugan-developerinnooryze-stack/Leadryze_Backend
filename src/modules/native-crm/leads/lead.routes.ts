import { Router } from 'express';
import * as ctrl from './lead.controller';
import * as importCtrl from './lead-import.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createLeadSchema, updateLeadSchema, updateStageSchema } from './lead.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/',                 requirePermission('native_crm.leads.view'),   ctrl.list);
router.get('/stats',            requirePermission('native_crm.leads.view'),   ctrl.stats);
router.get('/export',           requirePermission('native_crm.leads.export'), ctrl.exportCsv);
router.post('/import',                    requirePermission('native_crm.leads.create'), importCtrl.importCsv);
router.get('/import/triage',              requirePermission('native_crm.leads.edit'),   importCtrl.listTriage);
router.post('/import/triage/:id/resolve', requirePermission('native_crm.leads.edit'),   importCtrl.resolveTriage);
router.post('/',                requirePermission('native_crm.leads.create'), validate({ body: createLeadSchema }), ctrl.create);
router.get('/:id',              requirePermission('native_crm.leads.view'),   validate({ params: idParam }),        ctrl.getOne);
router.put('/:id',              requirePermission('native_crm.leads.edit'),   validate({ params: idParam, body: updateLeadSchema }), requireUnlocked('leads'), ctrl.update);
router.delete('/:id',           requirePermission('native_crm.leads.delete'), validate({ params: idParam }),        requireUnlocked('leads'), ctrl.remove);
router.post('/:id/convert/contact',     requirePermission('native_crm.leads.edit'), validate({ params: idParam }), ctrl.convertToContact);
router.post('/:id/convert/opportunity', requirePermission('native_crm.leads.edit'), validate({ params: idParam }), ctrl.convertToOpportunity);
router.post('/:id/convert/customer',    requirePermission('native_crm.leads.edit'), validate({ params: idParam }), ctrl.convertToCustomer);
router.get('/:id/conversions',          requirePermission('native_crm.leads.view'), validate({ params: idParam }), ctrl.getConversions);
router.post('/:id/convert',     requirePermission('native_crm.leads.edit'), validate({ params: idParam }),        ctrl.convertLead);
// LR-NEG-001: a stage move is an edit, so a locked lead (e.g. auto-locked on
// Won) refuses it for non-admins, as PUT /:id does. Moves never saved while
// the version token was being stripped, which hid this missing check.
router.patch('/:id/stage',      requirePermission('native_crm.leads.edit'), validate({ params: idParam, body: updateStageSchema }), requireUnlocked('leads'), ctrl.updateStage);

export default router;
