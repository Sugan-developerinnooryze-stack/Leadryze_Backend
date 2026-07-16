import { Router } from 'express';
import * as controller from './connector.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Connectors
 *   description: External CRM and database connectors — Zoho, HubSpot, Salesforce, MySQL, PostgreSQL, MongoDB, REST API
 */

router.use(authenticate, requireTenant);

/**
 * @swagger
 * /connectors:
 *   get:
 *     tags: [Connectors]
 *     summary: List all active connectors for the tenant
 *     responses:
 *       200:
 *         description: Array of connector objects
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Connector'
 *   post:
 *     tags: [Connectors]
 *     summary: Create and connect a new data source
 *     description: |
 *       Supports the following connector types:
 *       - **zoho** — requires `clientId`, `clientSecret`, `authCode`
 *       - **hubspot** — requires `accessToken`
 *       - **salesforce** — requires `clientId` (Consumer Key), `clientSecret` (Consumer Secret), `loginUrl` (Instance URL). Uses Client Credentials OAuth flow.
 *       - **mysql** — requires `host`, `port`, `database`, `username`, `password`
 *       - **postgresql** — requires `host`, `port`, `database`, `username`, `password`
 *       - **mongodb** — requires `uri`
 *       - **rest** — requires `baseUrl`, optionally `apiKey`
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ConnectorCreate'
 *     responses:
 *       201: { description: Connector created and initial sync triggered }
 *       400: { description: Invalid credentials or connection failed }
 */
router.get('/', requirePermission('connector.view'), controller.getConnectors);
router.post('/', requirePermission('connector.configure'), controller.createConnector);

/**
 * @swagger
 * /connectors/{id}:
 *   get:
 *     tags: [Connectors]
 *     summary: Get a single connector by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Connector object }
 *       404: { description: Not found }
 *   put:
 *     tags: [Connectors]
 *     summary: Update connector configuration
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ConnectorCreate'
 *     responses:
 *       200: { description: Updated connector }
 *   delete:
 *     tags: [Connectors]
 *     summary: Disconnect and delete a connector
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Connector deleted }
 */
router.get('/:id', requirePermission('connector.view'), controller.getConnector);
router.put('/:id', requirePermission('connector.configure'), controller.updateConnector);
router.delete('/:id', requirePermission('connector.delete'), controller.deleteConnector);

/**
 * @swagger
 * /connectors/{id}/test:
 *   post:
 *     tags: [Connectors]
 *     summary: Test connector connectivity
 *     description: Attempts a live connection to verify credentials are valid.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Connection successful }
 *       400: { description: Connection failed }
 */
router.post('/:id/test', requirePermission('connector.view'), controller.testConnector);

/**
 * @swagger
 * /connectors/{id}/sync:
 *   post:
 *     tags: [Connectors]
 *     summary: Trigger a full CRM sync for this connector
 *     description: |
 *       Pulls all records from the external source into LeadRyze.
 *       - Deduplicates by externalId — safe to run multiple times
 *       - Mirror-delete guard — skips deletion if 0 records returned (prevents data wipe on auth failure)
 *       - Auto-discovers all modules (Accounts, Deals, Tasks, etc.) and syncs to CRM Data
 *       - Removes stale modules from previous syncs automatically
 *       - Auto-runs every 30 minutes via cron
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sync complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created: { type: integer }
 *                 updated: { type: integer }
 *                 deleted: { type: integer }
 */
router.post('/:id/sync', requirePermission('connector.sync'), controller.syncCRMCustomers);

/**
 * @swagger
 * /connectors/{id}/customers:
 *   get:
 *     tags: [Connectors]
 *     summary: Fetch raw customer records directly from the external source
 *     description: Bypasses local DB and queries the external CRM/DB in real time.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Array of raw customer records from the source }
 */
router.get('/:id/customers', requirePermission('connector.view'), controller.fetchCRMCustomers);

/**
 * @swagger
 * components:
 *   schemas:
 *     Connector:
 *       type: object
 *       properties:
 *         _id:        { type: string }
 *         tenantId:   { type: string }
 *         name:       { type: string }
 *         type:       { type: string, enum: [zoho, hubspot, salesforce, mysql, postgresql, mongodb, rest] }
 *         isActive:   { type: boolean }
 *         syncStatus: { type: string, enum: [idle, syncing, error] }
 *         lastSyncAt: { type: string, format: date-time }
 *         createdAt:  { type: string, format: date-time }
 *     ConnectorCreate:
 *       type: object
 *       required: [name, type, config]
 *       properties:
 *         name: { type: string, example: My Zoho CRM }
 *         type:
 *           type: string
 *           enum: [zoho, hubspot, salesforce, mysql, postgresql, mongodb, rest]
 *         config:
 *           type: object
 *           description: Credentials vary by connector type
 *           example:
 *             clientId: 3MVG97L7...
 *             clientSecret: 037BAC88...
 *             loginUrl: https://orgfarm.develop.my.salesforce.com
 *         mapping:
 *           type: object
 *           description: Optional field mapping (not required for auto-discover connectors)
 */

export default router;
