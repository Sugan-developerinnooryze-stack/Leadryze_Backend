import { Router } from 'express';
import * as ctrl from './catalog-item.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCatalogItemSchema, updateCatalogItemSchema, importCatalogSchema } from './catalog-item.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();
router.get('/sources', requirePermission('fs.catalog.view'), ctrl.listSources);
router.post('/import', requirePermission('fs.catalog.create'), validate({ body: importCatalogSchema }), ctrl.importRows);
router.get('/', requirePermission('fs.catalog.view'), ctrl.list);
router.post('/', requirePermission('fs.catalog.create'), validate({ body: createCatalogItemSchema }), ctrl.create);
router.get('/:id', requirePermission('fs.catalog.view'), validate({ params: idParam }), ctrl.getOne);
router.put('/:id', requirePermission('fs.catalog.edit'), validate({ params: idParam, body: updateCatalogItemSchema }), ctrl.update);
router.delete('/:id', requirePermission('fs.catalog.delete'), validate({ params: idParam }), ctrl.remove);
export default router;
