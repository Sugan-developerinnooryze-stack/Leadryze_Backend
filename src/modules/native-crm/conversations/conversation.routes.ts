import { Router } from 'express';
import * as ctrl from './conversation.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import {
  listConversationsQuerySchema, sessionIdParam, replyBodySchema, createLeadBodySchema,
} from './conversation.validation';

const router = Router();

router.get('/', requirePermission('native_crm.conversations.view'), validate({ query: listConversationsQuerySchema }), ctrl.list);
router.get('/:sessionId', requirePermission('native_crm.conversations.view'), validate({ params: sessionIdParam }), ctrl.getOne);
router.post('/:sessionId/claim', requirePermission('native_crm.conversations.claim'), validate({ params: sessionIdParam }), ctrl.claim);
router.post('/:sessionId/reply', requirePermission('native_crm.conversations.reply'), validate({ params: sessionIdParam, body: replyBodySchema }), ctrl.reply);
router.post('/:sessionId/handback', requirePermission('native_crm.conversations.handback'), validate({ params: sessionIdParam }), ctrl.handback);
router.post('/:sessionId/create-lead', requirePermission('native_crm.conversations.reply'), validate({ params: sessionIdParam, body: createLeadBodySchema }), ctrl.createLead);

export default router;
