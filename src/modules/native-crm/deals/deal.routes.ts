import { Router } from 'express';
import * as ctrl from './deal.controller';
import * as importCtrl from './deal-import.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createDealSchema, updateDealSchema } from './deal.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.deals.view'), ctrl.list);
router.post('/', requirePermission('native_crm.deals.create'), validate({ body: createDealSchema }),                           ctrl.create);
router.get('/stats', requirePermission('native_crm.deals.view'), ctrl.stats);
router.post('/import', requirePermission('native_crm.deals.create'), importCtrl.importCsv);
router.get('/:id', requirePermission('native_crm.deals.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.deals.edit'), validate({ params: idParam, body: updateDealSchema }),          requireUnlocked('deals'), ctrl.update);
router.delete('/:id', requirePermission('native_crm.deals.delete'), validate({ params: idParam }),                                  requireUnlocked('deals'), ctrl.remove);
router.patch('/:id/stage', requirePermission('native_crm.deals.edit'), validate({ params: idParam }), ctrl.updateStage);

export default router;
