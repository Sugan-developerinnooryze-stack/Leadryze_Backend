import { Router } from 'express';
import * as ctrl from './contract.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createContractSchema, updateContractSchema } from './contract.validation';
import { requireUnlocked } from '../record-lock/record-lock.middleware';

const router = Router();

router.get('/',       requirePermission('fs.contracts.view'),   ctrl.list);
router.post('/',      requirePermission('fs.contracts.create'), validate({ body: createContractSchema }),                      ctrl.create);
// Schedule engine endpoints — registered before /:id
router.post('/schedule-preview',           requirePermission('fs.contracts.view'),   ctrl.schedulePreview);
router.patch('/:id/visit-status',          requirePermission('fs.contracts.edit'),   validate({ params: idParam }),            ctrl.visitStatus);
router.post('/:id/generate-workorders',    requirePermission('fs.contracts.edit'),   validate({ params: idParam }),            ctrl.generateWorkorders);
router.get('/:id',    requirePermission('fs.contracts.view'),   validate({ params: idParam }),                                 ctrl.getOne);
router.put('/:id',    requirePermission('fs.contracts.edit'),   validate({ params: idParam, body: updateContractSchema }),    requireUnlocked('contracts'), ctrl.update);
router.delete('/:id', requirePermission('fs.contracts.delete'), validate({ params: idParam }),                                 requireUnlocked('contracts'), ctrl.remove);

export default router;
