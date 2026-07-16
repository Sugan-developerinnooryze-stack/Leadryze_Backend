import { Router } from 'express';
import { authorize } from '../../../middlewares/auth.middleware';
import * as ctrl from './branch.controller';

const router = Router();

router.get('/',     ctrl.list);
router.get('/:id',  ctrl.getOne);
router.post('/',    authorize('SUPER_ADMIN', 'TENANT_ADMIN'), ctrl.create);
router.put('/:id',  authorize('SUPER_ADMIN', 'TENANT_ADMIN'), ctrl.update);
router.delete('/:id', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), ctrl.deactivate);

export default router;
