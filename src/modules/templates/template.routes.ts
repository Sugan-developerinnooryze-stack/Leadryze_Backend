import { Router } from 'express';
import * as controller from './template.controller';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { validate } from '../../middleware/validate.middleware';
import { idParam } from '../../utils/common.schemas';
import { createTemplateSchema, updateTemplateSchema, testSendTemplateSchema } from './template.validation';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Templates
 *   description: Email and WhatsApp message templates
 */

// Drive-by fix: every other gated module checks its own nav flag here —
// Templates never did, so disabling it only hid the sidebar link while the
// API kept answering 200 (same bug class already found and fixed for
// Campaigns as LR-PERM-001). nav_templates defaults to true, so no
// currently-working tenant is affected.
router.use(authenticate, requireTenant, requireModuleEnabled('nav_templates'));
router.get('/', requirePermission('templates.view'), controller.getTemplates);
router.post('/seed', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), controller.seedTemplates);
router.post('/', requirePermission('templates.create'), validate({ body: createTemplateSchema }), controller.createTemplate);
router.get('/:id', requirePermission('templates.view'), validate({ params: idParam }), controller.getTemplate);
router.put('/:id', requirePermission('templates.edit'), validate({ params: idParam, body: updateTemplateSchema }), controller.updateTemplate);
router.delete('/:id', requirePermission('templates.delete'), validate({ params: idParam }), controller.deleteTemplate);

// Lifecycle/action routes — additive, the CRUD routes above are untouched.
router.post('/:id/activate', requirePermission('templates.activate'), validate({ params: idParam }), controller.activateTemplate);
router.post('/:id/duplicate', requirePermission('templates.create'), validate({ params: idParam }), controller.duplicateTemplate);
router.post('/:id/preview', requirePermission('templates.view'), validate({ params: idParam }), controller.previewTemplate);
router.post('/:id/test-send', requirePermission('templates.activate'), validate({ params: idParam, body: testSendTemplateSchema }), controller.testSendTemplate);
router.get('/:id/usage', requirePermission('templates.view'), validate({ params: idParam }), controller.getTemplateUsage);

export default router;
