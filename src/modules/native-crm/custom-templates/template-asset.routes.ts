import { Router } from 'express';
import * as ctrl from './template-asset.controller';
import { upload } from '../../../middlewares/upload.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/',    requirePermission('doc_templates.view'),   ctrl.list);
router.post('/',   requirePermission('doc_templates.manage'), upload.single('file'), ctrl.uploadAsset);
router.delete('/:id', requirePermission('doc_templates.manage'), ctrl.remove);

export default router;
