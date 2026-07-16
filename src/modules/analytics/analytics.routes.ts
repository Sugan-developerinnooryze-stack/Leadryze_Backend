import { Router } from 'express';
import * as controller from './analytics.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Analytics
 *   description: Analytics and reporting
 */

router.use(authenticate, requireTenant);

/**
 * @swagger
 * /analytics/dashboard:
 *   get:
 *     tags: [Analytics]
 *     summary: Get dashboard KPI stats
 *     responses:
 *       200: { description: Stats aggregation }
 */
router.get('/dashboard', controller.getDashboard);

/**
 * @swagger
 * /analytics:
 *   get:
 *     tags: [Analytics]
 *     summary: Get analytics by date range
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: channel
 *         schema: { type: string }
 */
router.get('/', controller.getAnalytics);

export default router;
