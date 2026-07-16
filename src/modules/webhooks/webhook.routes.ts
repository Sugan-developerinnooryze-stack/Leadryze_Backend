import { Router } from 'express';
import * as controller from './webhook.controller';
import { webhookRateLimit } from '../../middlewares/rate-limit.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Inbound webhook receivers for all channels
 */

// WhatsApp
router.get('/whatsapp', controller.verifyWhatsApp);
router.post('/whatsapp', webhookRateLimit, controller.receiveWhatsApp);

// Instagram / Messenger
router.get('/instagram', controller.verifyInstagram);
router.post('/instagram', webhookRateLimit, controller.receiveInstagram);

// Twilio (SMS / Phone)
router.post('/twilio', webhookRateLimit, controller.receiveTwilio);

// HubSpot CRM — bidirectional sync (HubSpot → LeadRyze)
router.post('/hubspot', webhookRateLimit, controller.receiveHubSpot);

export default router;
