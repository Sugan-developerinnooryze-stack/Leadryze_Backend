import { Router } from 'express';
import * as ctrl from './company.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCompanySchema, updateCompanySchema } from './company.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/', requirePermission('native_crm.companies.view'), ctrl.list);
router.post('/', requirePermission('native_crm.companies.create'), validate({ body: createCompanySchema }),                        ctrl.create);
router.get('/stats', requirePermission('native_crm.companies.view'), ctrl.stats);
router.get('/:id', requirePermission('native_crm.companies.view'), validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id', requirePermission('native_crm.companies.edit'), validate({ params: idParam, body: updateCompanySchema }),       ctrl.update);
router.delete('/:id', requirePermission('native_crm.companies.delete'), validate({ params: idParam }),                                  ctrl.remove);

export default router;
