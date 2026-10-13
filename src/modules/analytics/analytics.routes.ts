import { Router } from 'express';
import * as controller from './analytics.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Analytics
 *   description: Platform-wide analytics and business intelligence
 */

router.use(authenticate, requireTenant, resolveBranch);

// Executive Dashboard & Overview
router.get('/dashboard', requirePermission('analytics.view'), controller.getDashboard);

// Domain-specific Business Intelligence
router.get('/leads-sales', requirePermission('analytics.view'), controller.getLeadsSales);
router.get('/crm', requirePermission('analytics.view'), controller.getCrm);
router.get('/support', requirePermission('analytics.view'), controller.getSupport);
router.get('/field-service', requirePermission('analytics.view'), controller.getFieldService);
router.get('/automation', requirePermission('analytics.view'), controller.getAutomation);

// Export CSV
router.get('/export', requirePermission('analytics.view'), controller.exportAnalytics);

// Legacy range query
router.get('/', requirePermission('analytics.view'), controller.getAnalytics);

export default router;
