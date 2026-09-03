import { Router } from 'express';
import { upload } from '../../../middlewares/upload.middleware';
import * as ctrl from './fs-settings.controller';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/',                      requirePermission('fs.settings.view'), ctrl.get);
router.put('/',                      requirePermission('fs.settings.edit'), ctrl.upsert);
router.post('/upload',               requirePermission('fs.settings.edit'), upload.single('file'), ctrl.uploadFile);
router.get('/template-preferences',  requirePermission('fs.settings.view'), ctrl.getTemplatePreferences);
router.put('/template-preferences',  requirePermission('fs.settings.edit'), ctrl.setTemplatePreferences);

export default router;
