import { Router } from 'express';
import * as ctrl from './template-analysis.controller';
import { upload } from '../../../middlewares/upload.middleware';

const router = Router();

router.post('/', upload.single('file'), ctrl.analyze);

export default router;
