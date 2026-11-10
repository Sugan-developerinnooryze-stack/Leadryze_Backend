import { Router, Response, NextFunction } from 'express';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import {
  forwardCrmChat, getCrmChatbotStatus, isValidClientSessionId,
  forwardCrmModuleDraft, parseCrmModuleDraftDescription, CrmModuleDraftUnavailableError, CRM_MODULE_DRAFT_MAX_LENGTH,
  parseClientContext, parseChatAction, parseConfirmationAction,
} from './crm-chat.service';
import { crmChatRateLimit } from '../../middlewares/rate-limit.middleware';
import { aiServiceFailure, sendAiServiceFailure } from './ai-service-error';
import { logger } from '../../utils/logger';
import { Tenant } from '../tenants/tenant.model';
import { logAuditEvent } from '../logs/audit-log.model';
import { invalidateDailyEventsForTenant } from '../daily-events/daily-events.service';
import {
  getCrmAssistantSettings, getCrmAssistantConfig, parseToggleChanges, parseQuestionsBody,
  updateCrmAssistantToggles, saveSuggestedQuestions, CrmAssistantQuestionsConflictError, requireCrmAssistantFeature,
} from './crm-assistant-settings.service';
import crmAssistHumanRoutes from '../crm-assistant/assist.human.routes';
import { isEnglishLanguage, loadGatewayTenant } from '../crm-assistant/gates';
import { countableConnectorsFor } from '../crm-assistant/query/connector-counts';

/** Sibling to, and entirely separate from, ai.routes.ts (the staff proxy to
 * the AI service's lead-capture agent; the public website widget has its own
 * route, public-widget.controller.ts). This file exists only to carry
 * the internal CRM Assistant's traffic: ChatWidget.tsx (the internal,
 * logged-in-staff chat panel) -> here -> the AI microservice's own
 * /api/crm-chat route -> ai/src/agents/crm-chatbot.agent.ts. Nothing here
 * is reachable by, or shares a code path with, the public widget. */

const router = Router();

router.use(authenticate, requireTenant, resolveBranch);

/**
 * /api/v1/ai/crm-assist/* — the CRM assistant's own browser routes
 * (POST /crm-assist/view: sort, page or drop a filter of a chat table, with
 * no AI hop). They inherit authenticate, requireTenant and resolveBranch from
 * above; each route adds its own gates (assist.human.routes.ts).
 */
router.use('/crm-assist', crmAssistHumanRoutes);

/**
 * POST /api/v1/ai/crm-chat
 * body: { sessionId, message? }
 *       | { sessionId, confirmationAction: {operationId, decision: 'confirm'|'cancel'|'status', revision?, payloadHash?} }
 *       | { sessionId, action: { kind: 'legacy', message } }          (resend to the existing assistant)
 *       | { sessionId, action: { kind: 'run_plan', plan, label? } }   (a clarify choice's plan, run with no LLM call)
 *       | { sessionId, action: { kind: 'start', intent, label? } }    (a choice's or a record card's write intent: a guided form or a delete review, no LLM call)
 *       each optionally with clientContext { route?, focus?: {module, id}, operationId? } (a hint only)
 * A run_plan plan must pass the strict QueryPlanSchema (no tenant, user,
 * branch or role in it) and is forwarded as sent; the backend's /execute
 * re-runs it as the caller, under the same gates, like a table's handle.
 * A start intent must pass the strict WriteIntentSchema (no reserved key
 * such as tenantId, branchId, createdBy or ownerId in its values or
 * references) and is forwarded as sent; /execute checks the module, the
 * permission, the guided-forms setting and the record as the caller.
 * 20 requests a minute per user (crmChatRateLimit).
 */
router.post('/crm-chat', requirePermission('bot.use'), requireModuleEnabled('bot_enabled'), crmChatRateLimit, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { sessionId, message, confirmationAction: rawConfirmationAction, clientContext: rawClientContext, action: rawAction } = req.body as {
      sessionId?: string; message?: string; confirmationAction?: unknown;
      clientContext?: unknown; action?: unknown;
    };
    if (!sessionId || (!message?.trim() && rawConfirmationAction == null && rawAction == null)) {
      res.status(400).json({ success: false, message: 'sessionId and either message, confirmationAction or action are required' });
      return;
    }
    // The client's own session id is only a per-tab handle: it is
    // namespaced under the authenticated user before it reaches the AI
    // service (see forwardCrmChat), so one staff member can never read or
    // confirm another's conversation by guessing/reusing an id.
    if (!isValidClientSessionId(sessionId)) {
      res.status(400).json({ success: false, message: 'sessionId must be 8-128 characters: letters, numbers, "-" or "_".' });
      return;
    }
    const confirmationAction = parseConfirmationAction(rawConfirmationAction);
    if (confirmationAction === null) {
      res.status(400).json({ success: false, message: 'confirmationAction must be { operationId, decision: "confirm" | "cancel" | "status", revision?, payloadHash? }.' });
      return;
    }
    const clientContext = parseClientContext(rawClientContext);
    if (clientContext === null) {
      res.status(400).json({ success: false, message: 'clientContext is invalid.' });
      return;
    }
    const action = parseChatAction(rawAction);
    if (action === null) {
      res.status(400).json({ success: false, message: 'action must be { kind: "legacy", message }, { kind: "run_plan", plan, label? } or { kind: "start", intent, label? }.' });
      return;
    }
    // The AI service's `data` (response, source, confirmation, and for a
    // confirmationAction the outcome {status, kind}) is passed through as-is;
    // visual answer blocks (`views`) are re-checked first (forwardCrmChat).
    const data = await forwardCrmChat({
      tenantId: req.tenantId!, role: req.user!.role, roleId: req.user!.roleId, userId: req.user!.userId, branchId: req.branchId ?? null,
      sessionId, message, confirmationAction, clientContext, action,
    });
    sendSuccess(res, data, 'CRM assistant response generated');
  } catch (err) {
    // LR-PL-AI-001: a failed or busy AI service is a clear 503/504/502 reply
    // (try again in a minute), never a bare 500 with axios's text.
    const failure = aiServiceFailure(err);
    if (failure) { sendAiServiceFailure(res, failure, 'crm-chat', req.tenantId); return; }
    next(err);
  }
});

/**
 * POST /api/v1/ai/crm-module-draft
 * body: { description } (1..2000 characters after trimming)
 * The Custom Module builder's "describe it" box (contract D2): the AI service
 * turns the description into a draft the staff member reviews in the builder.
 * Nothing is created here — the builder's own POST /api/v1/custom-modules does
 * that after an explicit click. Same gates as /crm-chat plus the Custom
 * Modules flag and the permission to create module definitions.
 */
router.post(
  '/crm-module-draft',
  requirePermission('bot.use'),
  requireModuleEnabled('bot_enabled'),
  requireModuleEnabled('config_customModules'),
  requirePermission('custom_modules.definitions.manage'),
  // Settings → CRM Chatbot can switch the in-chat builder off.
  requireCrmAssistantFeature('customModule'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const description = parseCrmModuleDraftDescription((req.body as { description?: unknown } | undefined)?.description);
      if (description === null) {
        res.status(400).json({ success: false, message: `description is required (1-${CRM_MODULE_DRAFT_MAX_LENGTH} characters).` });
        return;
      }
      // tenantId / actorUserId come from the verified token, never the body.
      const data = await forwardCrmModuleDraft({ tenantId: req.tenantId!, actorUserId: req.user!.userId, description });
      sendSuccess(res, data, 'Module draft generated');
    } catch (err) {
      if (err instanceof CrmModuleDraftUnavailableError) {
        logger.warn('CRM module draft: AI service unreachable', { tenantId: req.tenantId, error: err.reason });
        res.status(502).json({ success: false, message: err.message });
        return;
      }
      next(err);
    }
  },
);

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

/** The connectors whose deals this user can count in the chat (the "How
 * many <X> deals?" chip). None for a tenant whose assistant isn't English:
 * the engine hands all its questions to the existing assistant (D17), which
 * can't count connector records, so the chip would always dead-end. A
 * failure there never fails the config: [] and a warning. */
async function countableConnectorsForRequest(req: AuthRequest): Promise<Array<{ type: string; label: string }>> {
  try {
    const tenant = await loadGatewayTenant(req.tenantId!);
    if (!isEnglishLanguage(tenant.language)) return [];
    return await countableConnectorsFor({
      tenantId: req.tenantId!,
      tenant,
      identity: { userId: req.user!.userId, role: req.user!.role, roleId: req.user!.roleId, branchId: req.branchId ?? null },
    });
  } catch (err) {
    logger.warn('CRM assistant config: countable connectors unavailable', { tenantId: req.tenantId, error: (err as Error)?.message });
    return [];
  }
}

/**
 * GET /api/v1/ai/crm-chatbot/config
 * What the chat panel itself needs: which assistant features are switched on
 * and the "Try asking" questions. Read by every staff user of the assistant,
 * so it carries the same gates as /crm-chat. countableConnectors: the
 * connector types whose deals this user can count, only when the answer
 * engine is on for the tenant (else []).
 */
router.get('/crm-chatbot/config', requirePermission('bot.use'), requireModuleEnabled('bot_enabled'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await getCrmAssistantConfig(req.tenantId!);
    const countableConnectors = data.engine === 'on' ? await countableConnectorsForRequest(req) : [];
    res.set('Cache-Control', 'no-store');
    sendSuccess(res, { ...data, countableConnectors });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/ai/crm-chatbot/settings
 * Settings → CRM Chatbot: the editable assistant settings. Admin-only, like
 * /crm-chatbot/status, and not gated by bot_enabled so an admin can prepare
 * the settings while the assistant is off.
 */
router.get('/crm-chatbot/settings', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    sendSuccess(res, await getCrmAssistantSettings(req.tenantId!));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/ai/crm-chatbot/settings
 * body: { dailyEventsEnabled?: boolean, customModuleEnabled?: boolean, visualAnswersEnabled?: boolean, workflowsEnabled?: boolean, staleLeadDays?: number (1-90) }
 */
router.patch('/crm-chatbot/settings', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  const parsed = parseToggleChanges(req.body);
  if ('error' in parsed) { sendError(res, parsed.error, 400); return; }
  try {
    const { before, after } = await updateCrmAssistantToggles(req.tenantId!, parsed.changes, req.user!.userId);
    // The next Daily Events read uses the new settings ("stuck after N days").
    invalidateDailyEventsForTenant(req.tenantId!);
    logAuditEvent('crm_assistant.features_updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      {
        tenantId: req.tenantId,
        target: 'CrmAssistantSettings',
        detail: {
          changes: parsed.changes,
          before: {
            dailyEventsEnabled: before.dailyEventsEnabled, customModuleEnabled: before.customModuleEnabled,
            visualAnswersEnabled: before.visualAnswersEnabled, workflowsEnabled: before.workflowsEnabled,
            staleLeadDays: before.staleLeadDays,
          },
        },
      });
    sendSuccess(res, after, 'Assistant settings saved');
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/ai/crm-chatbot/suggested-questions
 * body: { questions: string[] | null, revision: number }
 * Saves the whole "Try asking" list (null = back to the built-in questions).
 * 409 when someone else saved since `revision` was read.
 */
router.put('/crm-chatbot/suggested-questions', authorize('SUPER_ADMIN', 'TENANT_ADMIN'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  const parsed = parseQuestionsBody(req.body);
  if ('error' in parsed) { sendError(res, parsed.error, 400); return; }
  try {
    const { before, after } = await saveSuggestedQuestions(req.tenantId!, parsed.questions, parsed.revision, req.user!.userId);
    logAuditEvent('crm_assistant.suggested_questions_updated',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip },
      {
        tenantId: req.tenantId,
        target: 'CrmAssistantSettings',
        detail: {
          reset: parsed.questions === null,
          before: before.questionsCustomized ? before.questions.map((q) => q.text) : 'built-in questions',
          after: after.questionsCustomized ? after.questions.map((q) => q.text) : 'built-in questions',
        },
      });
    sendSuccess(res, after, parsed.questions === null ? 'Suggested questions reset' : 'Suggested questions saved');
  } catch (err) {
    if (err instanceof CrmAssistantQuestionsConflictError) { sendError(res, err.message, 409); return; }
    next(err);
  }
});

export default router;
