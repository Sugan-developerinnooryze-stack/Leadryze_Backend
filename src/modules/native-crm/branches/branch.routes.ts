import { Router } from 'express';
import { requirePermission } from '../../../middlewares/auth.middleware';
import * as ctrl from './branch.controller';

const router = Router();

router.get('/',     requirePermission('branches.view'), ctrl.list);
router.get('/:id',  requirePermission('branches.view'), ctrl.getOne);
router.post('/',    requirePermission('branches.manage'), ctrl.create);
router.put('/:id',  requirePermission('branches.manage'), ctrl.update);
router.delete('/:id', requirePermission('branches.manage'), ctrl.deactivate);

export default router;
