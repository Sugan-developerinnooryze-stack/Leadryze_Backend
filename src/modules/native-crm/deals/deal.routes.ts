import { Router } from 'express';
import * as ctrl from './deal.controller';
import * as importCtrl from './deal-import.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createDealSchema, updateDealSchema } from './deal.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();
router.get('/',        ctrl.list);
router.post('/',       validate({ body: createDealSchema }),                           ctrl.create);
router.get('/stats',   ctrl.stats);
router.post('/import', importCtrl.importCsv);
router.get('/:id',     validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',     validate({ params: idParam, body: updateDealSchema }),          requireUnlocked('deals'), ctrl.update);
router.delete('/:id',  validate({ params: idParam }),                                  requireUnlocked('deals'), ctrl.remove);
router.patch('/:id/stage', validate({ params: idParam }), ctrl.updateStage);

export default router;
