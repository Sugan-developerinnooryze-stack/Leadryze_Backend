import { Router } from 'express';
import * as ctrl from './template-analysis.controller';
import { upload } from '../../../middlewares/upload.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.post('/', requirePermission('doc_templates.manage'), upload.single('file'), ctrl.analyze);

export default router;
