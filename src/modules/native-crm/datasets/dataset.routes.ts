import { Router } from 'express';
import * as ctrl from './dataset.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { analyzeDatasetSchema, startImportSchema, toggleAvailableSchema, previewImageMatchSchema } from './dataset.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { uploadZip } from '../../../middlewares/upload.middleware';

const router = Router();
// Registered before /:id so 'analyze'/'import'/'import-images' are never
// swallowed as an id.
router.post('/analyze', requirePermission('fs.datasets.create'), validate({ body: analyzeDatasetSchema }), ctrl.analyze);
router.post('/import-images', requirePermission('fs.datasets.create'), uploadZip.single('file'), ctrl.uploadImageZip);
router.post('/preview-image-match', requirePermission('fs.datasets.create'), validate({ body: previewImageMatchSchema }), ctrl.previewImageMatchHandler);
router.post('/import',  requirePermission('fs.datasets.create'), validate({ body: startImportSchema }), ctrl.startImport);
router.get('/', requirePermission('fs.datasets.view'), ctrl.list);
router.get('/:id', requirePermission('fs.datasets.view'), validate({ params: idParam }), ctrl.getOne);
router.get('/:id/versions', requirePermission('fs.datasets.view'), validate({ params: idParam }), ctrl.listVersions);
router.put('/:id/available', requirePermission('fs.datasets.edit'), validate({ params: idParam, body: toggleAvailableSchema }), ctrl.toggleAvailable);
router.delete('/:id', requirePermission('fs.datasets.delete'), validate({ params: idParam }), ctrl.remove);
export default router;
