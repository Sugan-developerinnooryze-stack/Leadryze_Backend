import { Router } from 'express';
import * as controller from './template.controller';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Templates
 *   description: Email and WhatsApp message templates
 */

router.use(authenticate, requireTenant);
router.get('/', requirePermission('templates.view'), controller.getTemplates);
router.post('/seed', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), controller.seedTemplates);
router.post('/', requirePermission('templates.create'), controller.createTemplate);
router.get('/:id', requirePermission('templates.view'), controller.getTemplate);
router.put('/:id', requirePermission('templates.edit'), controller.updateTemplate);
router.delete('/:id', requirePermission('templates.delete'), controller.deleteTemplate);

export default router;
