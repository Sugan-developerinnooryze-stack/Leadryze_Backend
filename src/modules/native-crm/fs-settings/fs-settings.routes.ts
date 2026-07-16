import { Router } from 'express';
import { upload } from '../../../middlewares/upload.middleware';
import * as ctrl from './fs-settings.controller';

const router = Router();

router.get('/',                      ctrl.get);
router.put('/',                      ctrl.upsert);
router.post('/upload',               upload.single('file'), ctrl.uploadFile);
router.get('/template-preferences',  ctrl.getTemplatePreferences);
router.put('/template-preferences',  ctrl.setTemplatePreferences);

export default router;
