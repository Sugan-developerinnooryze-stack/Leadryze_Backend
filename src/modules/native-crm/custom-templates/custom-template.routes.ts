import { Router } from 'express';
import * as ctrl from './custom-template.controller';
import { validate } from '../../../middleware/validate.middleware';
import { createTemplateSchema, updateTemplateSchema } from './custom-template.validation';

const router = Router();

// /catalog must be registered before /:id or the param route swallows it
router.get('/catalog',        ctrl.getCatalog);
router.post('/seed-starter',  ctrl.seedStarter);
router.get('/',               ctrl.list);
router.get('/:id',            ctrl.getOne);
router.post('/',              validate({ body: createTemplateSchema }), ctrl.create);
router.put('/:id',            validate({ body: updateTemplateSchema }), ctrl.update);
router.delete('/:id',         ctrl.remove);
router.put('/:id/set-default',ctrl.setDefault);

export default router;
