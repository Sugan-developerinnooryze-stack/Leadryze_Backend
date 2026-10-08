import { Router } from 'express';
import * as controller from './campaign.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { validate } from '../../middleware/validate.middleware';
import { idParam } from '../../utils/common.schemas';
import { createCampaignSchema, updateCampaignSchema, testSendCampaignSchema } from './campaign.validation';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Campaigns
 *   description: Marketing campaign management
 */

// LR-PERM-001: every other gated module checks its own nav flag here —
// Campaigns never did, so disabling it only hid the sidebar link while the
// API kept answering 200.
router.use(authenticate, requireTenant, requireModuleEnabled('nav_campaigns'));
router.get('/', requirePermission('campaigns.view'), controller.getCampaigns);
router.post('/', requirePermission('campaigns.create'), validate({ body: createCampaignSchema }), controller.createCampaign);
router.get('/:id', requirePermission('campaigns.view'), validate({ params: idParam }), controller.getCampaign);
router.put('/:id', requirePermission('campaigns.edit'), validate({ params: idParam, body: updateCampaignSchema }), controller.updateCampaign);
router.delete('/:id', requirePermission('campaigns.delete'), validate({ params: idParam }), controller.deleteCampaign);

// Lifecycle actions — additive, the CRUD routes above are untouched.
router.post('/:id/activate', requirePermission('campaigns.activate'), validate({ params: idParam }), controller.activateCampaign);
router.post('/:id/pause', requirePermission('campaigns.activate'), validate({ params: idParam }), controller.pauseCampaign);
router.post('/:id/resume', requirePermission('campaigns.activate'), validate({ params: idParam }), controller.resumeCampaign);
router.post('/:id/cancel', requirePermission('campaigns.activate'), validate({ params: idParam }), controller.cancelCampaign);
router.post('/:id/duplicate', requirePermission('campaigns.create'), validate({ params: idParam }), controller.duplicateCampaign);
router.post('/:id/test-send', requirePermission('campaigns.activate'), validate({ params: idParam, body: testSendCampaignSchema }), controller.testSendCampaign);
router.post('/:id/audience-preview', requirePermission('campaigns.view'), validate({ params: idParam }), controller.audiencePreview);
router.get('/:id/recipients', requirePermission('campaigns.view'), validate({ params: idParam }), controller.getCampaignRecipients);

export default router;
