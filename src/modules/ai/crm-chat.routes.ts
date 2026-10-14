import { Router, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess } from '../../utils/response';
import { forwardCrmChat } from './crm-chat.service';

/** Sibling to, and entirely separate from, ai.routes.ts (the public AI
 * Chatbot Widget's own proxy — untouched). This file exists only to carry
 * the internal CRM Assistant's traffic: ChatWidget.tsx (the internal,
 * logged-in-staff chat panel) -> here -> the AI microservice's own
 * /api/crm-chat route -> ai/src/agents/crm-chatbot.agent.ts. Nothing here
 * is reachable by, or shares a code path with, the public widget. */

const router = Router();

router.use(authenticate, requireTenant, resolveBranch);

/**
 * POST /api/v1/ai/crm-chat
 * body: { sessionId, message? } | { sessionId, confirmationAction: {operationId, decision} }
 */
router.post('/crm-chat', requirePermission('bot.use'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { sessionId, message, confirmationAction } = req.body as {
      sessionId?: string; message?: string; confirmationAction?: { operationId: string; decision: 'confirm' | 'cancel' };
    };
    if (!sessionId || (!message?.trim() && !confirmationAction)) {
      res.status(400).json({ success: false, message: 'sessionId and either message or confirmationAction are required' });
      return;
    }
    const data = await forwardCrmChat({
      tenantId: req.tenantId!, role: req.user!.role, roleId: req.user!.roleId, userId: req.user!.userId, branchId: req.branchId ?? null,
      sessionId, message, confirmationAction,
    });
    sendSuccess(res, data, 'CRM assistant response generated');
  } catch (err) {
    next(err);
  }
});

export default router;
