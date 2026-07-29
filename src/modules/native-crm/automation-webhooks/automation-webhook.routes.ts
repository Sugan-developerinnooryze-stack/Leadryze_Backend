import { Router } from 'express';
import * as controller from './automation-webhook.controller';
import { webhookTriggerParamsSchema } from './automation-webhook.validation';
import { webhookRateLimit } from '../../../middlewares/rate-limit.middleware';
import { validate } from '../../../middleware/validate.middleware';

const router = Router();

router.post('/trigger/:token', webhookRateLimit, validate({ params: webhookTriggerParamsSchema }), controller.trigger);

export default router;
