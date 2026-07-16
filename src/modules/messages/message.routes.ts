import { Router } from 'express';
import * as controller from './message.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Messages
 *   description: Conversation messages across all channels
 */

router.use(authenticate, requireTenant);
router.get('/', controller.getMessages);
router.get('/conversation/:sessionId', controller.getConversation);

export default router;
