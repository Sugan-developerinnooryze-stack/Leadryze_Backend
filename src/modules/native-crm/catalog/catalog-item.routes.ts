import { Router } from 'express';
import * as ctrl from './catalog-item.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createCatalogItemSchema, updateCatalogItemSchema, importCatalogSchema } from './catalog-item.validation';

const router = Router();
router.get('/sources', ctrl.listSources);
router.post('/import', validate({ body: importCatalogSchema }), ctrl.importRows);
router.get('/', ctrl.list);
router.post('/', validate({ body: createCatalogItemSchema }), ctrl.create);
router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.put('/:id', validate({ params: idParam, body: updateCatalogItemSchema }), ctrl.update);
router.delete('/:id', validate({ params: idParam }), ctrl.remove);
export default router;
