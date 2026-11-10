import axios from 'axios';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config, engineModeFor } from '../../config';
import { CRM_ASSISTANT_AUDIENCE } from './crm-assistant-token';
import { ClientContext, ClientContextSchema } from '../crm-assistant/contracts/plan';
import { RunPlanAction, RunPlanActionSchema, StartAction, StartActionSchema } from '../crm-assistant/contracts/api';
import { validateViews } from '../crm-assistant/contracts/views';
import { isCrmAssistantFeatureEnabled } from './crm-assistant-settings.service';
import { logger } from '../../utils/logger';

const aiHeaders = { 'x-api-key': config.ai.internalApiKey };
const AI_URL = config.app.aiServiceUrl;

/** Resends a message to the existing (legacy) assistant, e.g. from a "Use
 * the classic assistant" chip. */
export interface LegacyChatAction { kind: 'legacy'; message: string }

/** A choice the staff member picked on a clarify block, sent instead of a
 * message: 'legacy' above, 'run_plan' (Increment 4), the choice's plan,
 * which the AI service runs with no LLM call through the backend's
 * /execute, re-checked there under the caller's own identity and gates; or
 * 'start' (Increment 6), a choice's or a record card's write intent, which
 * the AI service sends to /execute the same way to open a guided form or a
 * delete review. */
export type ChatAction = LegacyChatAction | RunPlanAction | StartAction;

export interface CrmChatForwardInput {
  tenantId: string;
  role: string;
  roleId?: string;
  userId: string;
  branchId?: string | null;
  sessionId: string;
  message?: string;
  confirmationAction?: CrmConfirmationAction;
  /** A hint about where the user is (route, open record); re-checked server-side. */
  clientContext?: ClientContext;
  action?: ChatAction;
}

/** Confirm / Cancel on a proposal card, or (decision 'status') a check on a
 * confirm whose result is not known yet. revision and payloadHash are what
 * the review card showed for a server-staged record change ("op_" ids); the
 * AI service and the operations store re-check them. */
const ConfirmationActionSchema = z.object({
  operationId: z.string().min(1).max(100),
  decision: z.enum(['confirm', 'cancel', 'status']),
  revision: z.number().int().min(1).optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type CrmConfirmationAction = z.infer<typeof ConfirmationActionSchema>;

/** undefined when absent (or null), null when invalid, else the parsed action. */
export function parseConfirmationAction(value: unknown): CrmConfirmationAction | undefined | null {
  if (value === undefined || value === null) return undefined;
  const parsed = ConfirmationActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** undefined when absent (or null), null when invalid, else the parsed value. */
export function parseClientContext(value: unknown): ClientContext | undefined | null {
  if (value === undefined || value === null) return undefined;
  const parsed = ClientContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const LegacyActionSchema = z.object({
  kind: z.literal('legacy'),
  message: z.string().min(1).max(4000).refine((m) => m.trim().length > 0),
}).strict();

/* run_plan and start use the contract's own schemas: the plan must pass the
 * strict QueryPlanSchema and the intent the strict WriteIntentSchema (no
 * reserved key such as tenantId, branchId, createdBy or ownerId in its
 * values or references), so an action naming a tenant, user, branch or role
 * (or any key the contract doesn't know) is refused here, never forwarded
 * with the key quietly dropped. */
const ChatActionSchema = z.discriminatedUnion('kind', [LegacyActionSchema, RunPlanActionSchema, StartActionSchema]);

/** undefined when absent (or null), null when invalid, else the action as
 * sent: every kind is strict, with no defaults or transforms, so the action
 * the AI service receives equals the one the browser sent. */
export function parseChatAction(value: unknown): ChatAction | undefined | null {
  if (value === undefined || value === null) return undefined;
  const parsed = ChatActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The AI service's reply, with its visual answer blocks re-checked before
 * they reach the browser: every block must pass validateViews (known type,
 * size caps, links only to the app's own routes) or it is dropped; all of
 * them are dropped when the tenant switched visual answers off. response,
 * source, confirmation, outcome and meta are passed through untouched. */
export async function guardCrmChatViews(data: any, tenantId: string, role: string): Promise<any> {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('views' in data)) return data;
  const { views: rawViews, ...rest } = data as Record<string, unknown>;
  if (rawViews === undefined || rawViews === null) return rest;
  const enabled = await isCrmAssistantFeatureEnabled(tenantId, 'visualAnswers', role).catch(() => false);
  if (!enabled) return rest;
  const { views, dropped } = validateViews(rawViews);
  if (dropped.length) logger.warn('CRM chat proxy: view blocks dropped', { tenantId, dropped: dropped.slice(0, 12) });
  return views && views.blocks.length ? { ...rest, views } : rest;
}

/** Mints the same shape of short-lived internalAuth JWT ai.routes.ts's own
 * /chat handler already mints (same secret, same 2-minute expiry, same claim
 * set), plus aud "crm-assistant": authenticate() refuses that audience, so
 * this token is good only on the internal CRM gateway, never as a login
 * session on /api/v1. Not a new auth mechanism. */
export function mintCrmChatInternalAuth(input: Pick<CrmChatForwardInput, 'tenantId' | 'role' | 'roleId' | 'userId' | 'branchId'>): string {
  return jwt.sign(
    { tenantId: input.tenantId, role: input.role, roleId: input.roleId, userId: input.userId, branchId: input.branchId ?? null },
    config.jwt.secret, { expiresIn: '2m', audience: CRM_ASSISTANT_AUDIENCE },
  );
}

/** A client-chosen chat session id: 8-128 of [A-Za-z0-9_-]. Accepts the
 * frontend's legacy "session-<Date.now()>" and a UUID; rejects anything
 * containing "." (the namespace separator below), spaces, etc. */
export const CLIENT_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidClientSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SESSION_ID_RE.test(value);
}

/** The session id the AI service sees: the client's id namespaced under
 * the AUTHENTICATED user (`<userId>.<clientSessionId>`), so conversation
 * memory and pending confirmations are per user — a client can't reach
 * another user's session by sending their id. */
export function namespacedSessionId(userId: string, clientSessionId: string): string {
  return `${userId}.${clientSessionId}`;
}

/** Forwards one CRM-assistant turn to the AI microservice's own /api/crm-chat
 * route (ai/src/api/crm-chat.routes.ts) — a route that exists solely for
 * this feature, never the public widget's /api/chat. `input.userId` must
 * come from the authenticated request (req.user), never the request body. */
export async function forwardCrmChat(input: CrmChatForwardInput): Promise<any> {
  const internalAuth = mintCrmChatInternalAuth(input);
  const response = await axios.post(
    `${AI_URL}/api/crm-chat`,
    {
      tenantId: input.tenantId,
      sessionId: namespacedSessionId(input.userId, input.sessionId),
      actorUserId: input.userId,
      message: input.message,
      confirmationAction: input.confirmationAction,
      internalAuth,
      // The answer-engine mode is decided here, per tenant (CRM_ASSIST_ENGINE).
      engine: engineModeFor(input.tenantId),
      ...(input.clientContext ? { clientContext: input.clientContext } : {}),
      ...(input.action ? { action: input.action } : {}),
    },
    // Same generous timeout as the public widget's own /chat proxy — real
    // tool-calling (schema lookup, customer search, propose/execute write)
    // can legitimately take several LLM round-trips.
    { headers: aiHeaders, timeout: 100000 },
  );
  return guardCrmChatViews(response.data.data, input.tenantId, input.role);
}

/** Custom Module builder's AI draft (contract D2). The AI service returns
 * `{ ok: true, draft, notes }` or `{ ok: false, reason, message,
 * retryAfterSeconds? }` and never creates anything. `actorUserId` must come
 * from the authenticated request (req.user), never the request body. */
export const CRM_MODULE_DRAFT_MAX_LENGTH = 2000;
export const CRM_MODULE_DRAFT_UNREACHABLE_MESSAGE = 'The AI service could not be reached — you can still build the module visually.';

export class CrmModuleDraftUnavailableError extends Error {
  /** The underlying failure, for logs only (never sent to the client). */
  readonly reason: string;

  constructor(cause?: unknown) {
    super(CRM_MODULE_DRAFT_UNREACHABLE_MESSAGE);
    this.name = 'CrmModuleDraftUnavailableError';
    this.reason = cause instanceof Error ? cause.message : 'unexpected AI service response';
  }
}

/** The trimmed description when it is a string of 1..2000 characters, else null. */
export function parseCrmModuleDraftDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= CRM_MODULE_DRAFT_MAX_LENGTH ? trimmed : null;
}

export async function forwardCrmModuleDraft(input: { tenantId: string; actorUserId: string; description: string }): Promise<any> {
  let response;
  try {
    response = await axios.post(
      `${AI_URL}/api/crm-module-draft`,
      { tenantId: input.tenantId, actorUserId: input.actorUserId, description: input.description },
      // One model call with a 30 s deadline on the AI side, plus margin.
      { headers: aiHeaders, timeout: 45000 },
    );
  } catch (err) {
    throw new CrmModuleDraftUnavailableError(err);
  }
  const data = response?.data?.data;
  if (response?.data?.success !== true || !data || typeof data !== 'object') {
    throw new CrmModuleDraftUnavailableError();
  }
  return data;
}

/** Backs the CRM Chatbot Settings tab's "AI Provider & Model" and "Rate
 * Limits & Safety" sections — forwards to the AI microservice's own
 * read-only /crm-chatbot-status/:tenantId. Never throws: a settings page
 * must degrade to "unavailable", never break, if the AI service is down. */
export async function getCrmChatbotStatus(tenantId: string): Promise<{
  provider: string; model: string; fallbackProvider: string; fallbackModel: string;
  connected: boolean; rateLimit: { allowed: boolean; remaining: number; resetIn: number; max: number };
} | null> {
  try {
    const response = await axios.get(`${AI_URL}/api/crm-chatbot-status/${tenantId}`, {
      headers: aiHeaders, timeout: 5000,
    });
    return response.data.data;
  } catch {
    return null;
  }
}
