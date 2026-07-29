import { Router } from 'express';
import * as ctrl from './template-asset.controller';
import { upload } from '../../../middlewares/upload.middleware';

const router = Router();

router.get('/',    ctrl.list);
router.post('/',   upload.single('file'), ctrl.uploadAsset);
router.delete('/:id', ctrl.remove);

export default router;
