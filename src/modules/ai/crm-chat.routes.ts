import { Router, Response, NextFunction } from 'express';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { forwardCrmChat, getCrmChatbotStatus } from './crm-chat.service';
import { Tenant } from '../tenants/tenant.model';

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
router.post('/crm-chat', requirePermission('bot.use'), requireModuleEnabled('bot_enabled'), async (req: AuthRequest, res: Response, next: NextFunction) => {
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

/**
 * GET /api/v1/ai/crm-chatbot/status
 * Backs the CRM Chatbot Settings tab — AI Provider & Model, Rate Limits &
 * Safety, and Feature & Access Controls sections. Deliberately NOT gated by
 * requireModuleEnabled('bot_enabled') (unlike POST /crm-chat above): a
 * tenant admin must be able to see this tab even when the assistant is
 * currently disabled, specifically so they can see THAT it's disabled.
 * Admin-only (not requirePermission('bot.use')) since this is settings
 * visibility, not assistant usage — the same isAdmin gate SettingsPage.tsx
 * already applies to this tab on the frontend, enforced again here so a
 * non-admin can't reach it directly via the API either.
 */
router.get('/crm-chatbot/status', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await Tenant.findById(req.tenantId).select('aiConfig.toolModelPreset featureFlags.bot_enabled').lean();
    if (!tenant) { sendError(res, 'Tenant not found', 404); return; }

    const aiStatus = await getCrmChatbotStatus(req.tenantId!);
    sendSuccess(res, {
      botEnabled: tenant.featureFlags?.bot_enabled ?? true,
      toolModelPreset: tenant.aiConfig?.toolModelPreset ?? null,
      aiService: aiStatus, // null when the AI microservice itself is unreachable
    });
  } catch (err) {
    next(err);
  }
});

export default router;
