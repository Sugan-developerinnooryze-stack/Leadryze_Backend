import { z } from 'zod';
import {
  AssistSessionState, AssistSessionStateSchema, ClientContextSchema, PlannerCatalog, QueryPlanSchema, WriteIntentSchema,
} from './plan';
import { AppLink, OperationConfirmation, ResultBlock, ReviewBlock, ViewsEnvelope } from './views';

/* POST /api/internal/crm-assist/:tenantId/resolve — called only by the AI
 * service, with x-internal-key plus the assistant's internalAuth token in the
 * x-internal-auth header (aud "crm-assistant"). Identity comes from that token
 * only; nothing in the body can name a tenant, user, branch or role.
 * Copied in ai/src/contracts/assistant-views.ts. */

export const RESOLVE_MODES = ['answer', 'parse_only'] as const;

const SessionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/);

export const ResolveRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  /** 'parse_only' (engine=shadow): parse and report, run no query. */
  mode: z.enum(RESOLVE_MODES).optional(),
  /** The AI service's (backend-namespaced) chat session; a form starts in it, and a typed answer fills only its own draft. */
  sessionId: SessionIdSchema.optional(),
  state: AssistSessionStateSchema.optional(),
  clientContext: ClientContextSchema.optional(),
}).strict();
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

/** Why a message goes back to the existing (legacy) assistant. */
export const LEGACY_REASONS = [
  'write',          // write wording the guided forms don't take: another module, workflows off
  'config',         // Custom Module or field configuration wording
  'needs_planner',  // a read the grammar can't fully parse (answered as kind 'needs_planner' since Increment 4)
  'unsupported',    // parsed, but this engine can't answer it yet
] as const;
export type LegacyReason = typeof LEGACY_REASONS[number];

/** How an answer was reached. The backend reports 0 LLM calls; the AI
 * service sets the real count on the reply it sends on. */
export type AnswerPath = 'grammar' | 'planner' | 'action' | 'clarify' | 'workflow';

export type ResolveResult =
  | {
      kind: 'answer';
      /** Deterministic text for clients without blocks (pipe tables, "Showing N of TOTAL", no ids). */
      response: string;
      /** The badge string: SourceRef labels joined in order, e.g. "Field Service". */
      source: string;
      views: ViewsEnvelope;
      meta: { path: AnswerPath; llmCalls: 0; interpretedAs?: string };
      /** The one line kept in conversation history instead of the rows. Never ends in "?". */
      summary: string;
      /** Replaces the AI service's stored session state (lastPlan etc.). A hint only. */
      state?: AssistSessionState;
      /** Present only when the answer shows a review: a delete started from chat, or "review" typed into the chat. */
      confirmation?: OperationConfirmation;
    }
  /** A read the grammar can't fully parse (any read, for a tenant whose
   * assistant language isn't English): the AI service asks the planner, once,
   * with this catalog, then sends the planner's output to /execute. */
  | {
      kind: 'needs_planner';
      catalog: PlannerCatalog;
      /** Module keys and filter keys the grammar saw (keys only, never values), for the AI service's log. */
      modules: string[];
      filterKeys: string[];
    }
  | { kind: 'legacy'; reason: LegacyReason }
  | {
      kind: 'parse_only';
      /** What engine=on would have done with this message. */
      path: 'grammar' | 'planner' | 'legacy';
      reason?: LegacyReason;
      op?: string;
      modules: string[];
      /** Filter keys only, never values. */
      filterKeys: string[];
    };

/* ── Operations (Increment 2) ────────────────────────────────────────────
 * A change the existing assistant proposes is staged on the server (sealed,
 * owned by tenant + user + session + branch, 10-minute expiry) and reviewed
 * there; Confirm runs exactly that payload once. Same headers and identity
 * rules as resolve. Routes, under /api/internal/crm-assist/:tenantId:
 *   POST operations                 StageOperationRequest   -> StageOperationResult
 *   POST operations/:id/confirm     ConfirmOperationRequest -> OperationOutcome
 *   POST operations/:id/cancel      SessionOnlyRequest      -> OperationOutcome
 *   POST operations/:id/status      SessionOnlyRequest      -> OperationOutcome  */

export const OPERATION_ID_RE = /^op_[A-Za-z0-9_-]{16,64}$/;

export const StageOperationRequestSchema = z.object({
  /** The AI service's (backend-namespaced) chat session: the operation belongs to it. */
  sessionId: SessionIdSchema,
  module: z.string().min(1).max(60),
  op: z.enum(['create', 'update', 'delete']),
  /** Required for update and delete: the record's _id as the assistant found it. */
  recordId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  /** Proposed values for create and update; validated and reduced on the server. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** The model's own one-line description. Never shown as the review; not stored. */
  summary: z.string().max(500).optional(),
}).strict();
export type StageOperationRequest = z.infer<typeof StageOperationRequestSchema>;

export type StageOperationResult =
  | {
      ok: true;
      operationId: string;
      revision: number;
      payloadHash: string;
      expiresAt: string;
      /** Server-written one-line description of the change, for the chat bubble. */
      summary: string;
      review: ReviewBlock;
    }
  | {
      ok: false;
      code: 'validation' | 'not_found' | 'no_permission' | 'disabled' | 'refused' | 'stale_write';
      /** Server-written, safe to show. */
      message: string;
      fieldErrors?: Record<string, string>;
    };

export const ConfirmOperationRequestSchema = z.object({
  sessionId: SessionIdSchema,
  /** As shown on the review card. A confirm without them is accepted only at revision 1. */
  revision: z.number().int().min(1).optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ConfirmOperationRequest = z.infer<typeof ConfirmOperationRequestSchema>;

export const SessionOnlyRequestSchema = z.object({ sessionId: SessionIdSchema }).strict();
export type SessionOnlyRequest = z.infer<typeof SessionOnlyRequestSchema>;

export interface OperationOutcome {
  operationId: string;
  /** 'pending' = still staged (status check before a confirm, or a refused confirm that can be retried). */
  status: 'pending' | 'applied' | 'failed' | 'unknown' | 'cancelled' | 'expired' | 'superseded';
  /** True when this confirm or status found the operation already finished (a repeat click). */
  repeat?: boolean;
  record?: { id: string; number?: string; title: string; href?: AppLink };
  /** Server-written, safe to show. */
  message: string;
  /** The result card; absent while pending. */
  result?: ResultBlock;
}

/* ── Execute (Increment 4) ───────────────────────────────────────────────
 * POST /api/internal/crm-assist/:tenantId/execute — same callers, headers,
 * identity rules and per-user limit as resolve. Runs one of:
 *  - planner:  the planner's tool arguments, unchecked here on purpose: the
 *              server checks them strictly (PlannerOutputSchema, the caller's
 *              modules, the catalog's values) and grounds every free-text
 *              value and number in `message`; what fails becomes a clarify,
 *              never a second LLM call.
 *  - run_plan: a clarify choice's plan (no grounding: the server wrote it),
 *              re-run as the caller, like a table's handle.
 *  - start:    a clarify choice's or a record action's write intent
 *              (Increment 6): a guided form or a delete review, no LLM call.
 *  - fallback: no usable planner answer (the governor refused, the provider
 *              failed, the output couldn't be read): the clarify that says so,
 *              with the wait when one is known.
 * The answer is always kind 'answer' (data, a notice, a form, a review or a clarify). */

export const EXECUTE_FALLBACKS = ['planner_busy', 'planner_unavailable', 'not_understood'] as const;
export type ExecuteFallback = typeof EXECUTE_FALLBACKS[number];

/** When a new planner question can run again, if the AI service knows: the
 * tenant's one planner question a minute ('tenant', decision D31) or the
 * platform's per-minute budget ('platform'), and about how many seconds
 * until then. Only for the wording of the clarify; nothing waits. */
export const ExecuteFallbackWaitSchema = z.object({
  by: z.enum(['tenant', 'platform']),
  seconds: z.number().int().min(1).max(600),
}).strict();
export type ExecuteFallbackWait = z.infer<typeof ExecuteFallbackWaitSchema>;

export const StartInputSchema = z.object({ kind: z.literal('start'), intent: WriteIntentSchema }).strict();

export const ExecuteRequestSchema = z.object({
  /** The AI service's (backend-namespaced) chat session: a fill binds only to this session's own draft operation. */
  sessionId: SessionIdSchema,
  /** The staff member's message as typed (placeholders restored). Required with input 'planner' and 'fallback'. */
  message: z.string().min(1).max(4000).optional(),
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('planner'), output: z.unknown() }).strict(),
    z.object({ kind: z.literal('run_plan'), plan: QueryPlanSchema }).strict(),
    StartInputSchema,
    z.object({ kind: z.literal('fallback'), reason: z.enum(EXECUTE_FALLBACKS), wait: ExecuteFallbackWaitSchema.optional() }).strict(),
  ]),
  state: AssistSessionStateSchema.optional(),
  clientContext: ClientContextSchema.optional(),
}).strict();
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
export type ExecuteResult = Extract<ResolveResult, { kind: 'answer' }>;

/* ── Chat actions (Increment 4) ─────────────────────────────────────────
 * POST /api/v1/ai/crm-chat { sessionId, action }: a clarify choice the staff
 * member picked. 'run_plan' runs the choice's plan with no LLM call (the AI
 * service sends it to /execute); 'start' (Increment 6) starts the choice's
 * or a record action's write intent the same way; 'legacy' (Increment 1)
 * hands a message to the existing assistant. */

export const RunPlanActionSchema = z.object({
  kind: z.literal('run_plan'),
  plan: QueryPlanSchema,
  /** The choice's label, kept as the staff member's line in the chat history. */
  label: z.string().min(1).max(120).optional(),
}).strict();
export type RunPlanAction = z.infer<typeof RunPlanActionSchema>;

export const StartActionSchema = z.object({
  kind: z.literal('start'),
  intent: WriteIntentSchema,
  /** The choice's label, kept as the staff member's line in the chat history. */
  label: z.string().min(1).max(120).optional(),
}).strict();
export type StartAction = z.infer<typeof StartActionSchema>;
