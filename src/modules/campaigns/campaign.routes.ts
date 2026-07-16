import { Router } from 'express';
import * as controller from './campaign.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Campaigns
 *   description: Marketing campaign management
 */

router.use(authenticate, requireTenant);
router.get('/', requirePermission('campaigns.view'), controller.getCampaigns);
router.post('/', requirePermission('campaigns.create'), controller.createCampaign);
router.get('/:id', requirePermission('campaigns.view'), controller.getCampaign);
router.put('/:id', requirePermission('campaigns.edit'), controller.updateCampaign);
router.delete('/:id', requirePermission('campaigns.delete'), controller.deleteCampaign);

export default router;
