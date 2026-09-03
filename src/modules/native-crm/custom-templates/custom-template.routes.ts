import { Router } from 'express';
import * as ctrl from './custom-template.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { createTemplateSchema, updateTemplateSchema } from './custom-template.validation';

const router = Router();

// /catalog must be registered before /:id or the param route swallows it
router.get('/catalog',        requirePermission('doc_templates.view'),   ctrl.getCatalog);
router.post('/seed-starter',  requirePermission('doc_templates.manage'), ctrl.seedStarter);
router.get('/',               requirePermission('doc_templates.view'),   ctrl.list);
router.get('/:id',            requirePermission('doc_templates.view'),   ctrl.getOne);
router.post('/',              requirePermission('doc_templates.manage'), validate({ body: createTemplateSchema }), ctrl.create);
router.put('/:id',            requirePermission('doc_templates.manage'), validate({ body: updateTemplateSchema }), ctrl.update);
router.delete('/:id',         requirePermission('doc_templates.manage'), ctrl.remove);
router.put('/:id/set-default',requirePermission('doc_templates.manage'), ctrl.setDefault);

export default router;
