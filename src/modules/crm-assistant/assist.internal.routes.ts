import { Router, Request, Response, NextFunction } from 'express';
import type { ZodIssue, ZodType } from 'zod';
import {
  ExecuteRequest, ExecuteRequestSchema, ExecuteResult, ResolveRequest, ResolveRequestSchema, ResolveResult,
  OPERATION_ID_RE, StageOperationRequestSchema, ConfirmOperationRequestSchema, SessionOnlyRequestSchema, OperationOutcome,
} from './contracts/api';
import type { AnswerPath, ExecuteFallback, ExecuteFallbackWait } from './contracts/api';
import { PLANNER_CAPS, PlannerOutputSchema, estimateTokens } from './contracts/plan';
import type { AssistSessionState, ClientContext, Cond, PlannerOutput, QueryPlan, WriteIntent } from './contracts/plan';
import {
  OperationCaller, OperationReply, WORKFLOWS_OFF_MESSAGE, checkAccess, stageOperation, confirmOperation, cancelOperation, operationStatus,
  writableModule,
} from './operations/operation.service';
import { FillBinding, bindFill } from './operations/fill-binding';
import { isWorkflowsEffective } from './operations/workflow-gate';
import { applyFill, cancelWorkflow, formSpecFor, reviewDraft, startWorkflow, workflowStatus } from './operations/workflow.service';
import { WORKFLOW_MODULE_KEYS } from './writes/workflow-modules';
import { workflowModuleFor } from './writes/write-caps';
import type { FillFormSpec, WorkflowCaller, WorkflowReply } from './writes/workflow-types';
import { getModuleCap } from './registry';
import { AssistIdentity, verifyAssistIdentity } from './identity';
import {
  GatewayTenant, IDENTITY_REQUIRED_MESSAGE, TENANT_INACTIVE_MESSAGE, gateModuleRead, isAdminIdentity, isEnglishLanguage, isTenantBlocked,
  loadGatewayTenant,
} from './gates';
import { CapabilityView, getCapabilityView } from './capability-view';
import { GrammarParse, grammarContextFromRegistry, parseMessage, parseSmallTalk } from './grammar/parse';
import { GrammarContext, loadGrammarContext } from './grammar/context';
import { parseFill, parseWriteIntent } from './grammar/write';
import type { Executor, PlanProblem, PlanProblemCode } from './query/validate';
import { businessNumberOf, validateQueryPlan } from './query/validate';
import { ExecContext, executeCount, executeList, loadReadContext, moduleDefFor } from './query/execute-list';
import {
  PlanRejectedError, executeQueryCount, executeQueryGroups, executeQueryList, fsAmountsRankable,
} from './query/execute-query';
import { ScopeFailClosedError } from './query/scoped-match';
import { MineUnavailableError } from './query/mine';
import { countConcept } from './query/source-counts';
import { countConnectorModule } from './query/connector-counts';
import type { RelatedGate } from './query/relations';
import { gateRelated, prepareRelation, relatedLabels } from './query/relations';
import { MetricOutcome, executeQueryMetric } from './query/metrics';
import { DetailRead, detailExtrasFor, readRecordByNumber, readRecordByRef } from './query/detail';
import { executeCustomPlan, validateCustomPlan } from './query/execute-custom';
import { MAX_CHART_POINTS, executeChartGroups } from './query/aggregate';
import { executePipeline, isPipelinePlan } from './query/pipeline';
import { chooseAgendaExecutor, resolveAgendaWindow, runAgendaD, runAgendaQ, validateAgendaPlan } from './query/agenda';
import type { ModuleCap, WriteOp } from './registry/types';
import { CONCEPTS, ConceptKey } from './registry/concepts';
import { SOURCE_LABELS } from './registry/labels';
import { CustomModuleAccess, CustomModuleInfo, customFieldFor, customModulesFor, isCustomModuleKey } from './registry/custom-modules';
import { VIEW_CAPS } from './contracts/views';
import type { NoticeBlock, RecordAction } from './contracts/views';
import { buildPlannerCatalog, plannerFormOf } from './planner-catalog';
import { GroundingDrop, GroundingFix, groundFill, groundPlan, groundWriteIntent, writtenCurrencyFor } from './planner-grounding';
import {
  ComposeEnv, ComposedAnswer, composeConceptCount, composeConceptFailed, composeConceptTimedOut, composeConnectorCount,
  composeConnectorFailed, composeConnectorTimedOut, composeCount, composeCustomModulesFailed, composeDetail, composeDuplicates,
  composeGreeting, composeGroups, composeHelp, composeList, composeMetric, composeMineUnavailable, composeModuleState, composeNotFound,
  composeQueryFailed, composeReadTimedOut, composeRelationOutcome, FS_RANKABLE_BUDGET, finalizeAnswer, fsRankableOnL,
} from './views/compose';
import {
  composeCustomAccess, composeCustomAnswer, composeCustomModuleMissing, composeCustomQueryFailed, composeCustomTimedOut,
} from './views/compose-custom';
import { composeWorkflowAnswer, workflowNotice } from './views/compose-form';
import { chartWanted, composeCountChart, composeMetricCharts, withPresentNotice } from './views/chart';
import { composePipeline } from './views/pipeline';
import { composeAgenda, composeAgendaFailed, composeAgendaTimedOut, composeAgendaTooLong } from './views/agenda';
import { relationWords } from './views/chips';
import { groupLabel, lowerLabel } from './views/interpret';
import {
  ClarifyContext, PIPELINE_QUESTION, composeAmbiguousModule, composeNeedsClassic, composeNoFocus, composeNotInTime,
  composeNotUnderstood, composeOutOfScope, composePlannerBusy, composePlannerClarify, composePlannerUnavailable, composeTooLong,
  withGroundingNotices,
} from './views/clarify';
import type { DataScope } from '../../types';
import { isCrmAssistantFeatureEnabled } from '../ai/crm-assistant-settings.service';
import { RECORD_SOURCES } from '../daily-events/daily-events.sources';
import { isModuleFlagDisabled, isRecordLockModule, moduleDisabledMessage } from '../internal/crm-gateway.helpers';
import { getLockStatus } from '../native-crm/record-lock/record-lock.service';
import { crmAssistInternalRateLimit } from '../../middlewares/rate-limit.middleware';
import { sendError, sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

/* POST /api/internal/crm-assist/:tenantId/resolve — the CRM assistant's
 * answer engine (Increment 3: grammar v1; executors L and Q; per-source
 * concept counts and connector counts. Increment 4: "mine", the hand-off to
 * the planner, and POST /execute below). Mounted inside internal.routes.ts,
 * so the x-internal-key check has already run. Then, in order: the
 * assistant identity from the x-internal-auth header (401), the tenant
 * still active (403), 60 calls a minute per verified user (429), the
 * request body (400) and the tenant's bot_enabled flag (403).
 *
 * The caller's capability view, the grammar context for those modules
 * (tenant stage words, cached), the parse. mode "parse_only" (engine=shadow)
 * stops there and reports keys only; it reads no records. Otherwise a
 * message the grammar fully understands is answered here with no AI call: a
 * read on the executor validateQueryPlan chose (L: the module's own list();
 * Q: scoped queries), a per-source concept count (countConcept) or a
 * connector count (countConnectorModule). A read the grammar can't fully
 * parse, and every message of a tenant whose assistant language isn't
 * English except small talk (D17: the grammar is English-only, so those are
 * read only for a greeting, thanks or help), comes back as
 * { kind: 'needs_planner' } with the catalog the planner is given
 * (planner-catalog.ts): the AI service asks the planner once and sends its
 * answer to /execute. A message longer than the planner reads gets a "too
 * long" clarify instead, and a caller who can read no module (neither a
 * registry module nor a Custom Module) gets help that says so, both with no
 * AI call. Write and
 * configuration wording, and a plan the engine refuses, come back as
 * { kind: 'legacy' } for the existing assistant. A module the caller can't
 * use gets an answer that says so, never a zero; a read that fails gets an
 * error notice, never a zero; "mine" that can't be told for this caller
 * (no staff profile, or a module with no owner) says why. An answer is due
 * by RESOLVE_DEADLINE (below): what hasn't finished by then is answered in
 * an error state, except a question not parsed yet or a read on executor L
 * (the module's own list(), as in Increment 1), which go to the existing
 * assistant. One log line per call: user, modules, filter keys (never
 * values), executor, counts, duration and path.
 *
 * Increment 5: a plan's relation ("customers with invoices", "work orders
 * for ABC Industries", "invoices for this work order") is worked out first,
 * under the other module's own gates and scope (query/relations.ts, with one
 * RelatedGate per call); one that can't run as asked is a notice or a
 * question back, never an empty list. Named totals (purchase amount,
 * outstanding, payments received) per currency. A record card carries its
 * lines, stored totals and related counts (query/detail.ts); records sharing
 * a number are a choice each, opened by their _id. The caller's Custom
 * Modules (read once per call) are module words for the grammar and are read
 * on executor M (query/execute-custom.ts), as a word naming both a built-in
 * module and a Custom Module is a choice of each.
 *
 * Increment 6 (spec B1, B12.9): guided forms, for the caller's own chat
 * session (body.sessionId, "<userId>.<the browser's session>") while
 * workflows are effective (operations/workflow-gate.ts). Write wording for
 * one of the 22 modules with a guided form (writes/workflow-modules.ts) that
 * the write grammar reads (grammar/write.ts) opens the form, or a delete's
 * review, or a refused operation's notice (Increment 7: an invoice's or a
 * quotation's delete), with no AI call (operations/workflow.service.ts
 * startWorkflow); a
 * read worded like a write ("new leads this week", L4) and a write the
 * grammar can't be sure of go to the planner. While the session's form is
 * open, a typed answer fills it, cancels it or sends it for review, or goes
 * to the planner with the form's fields; while its review card is open, it
 * changes nothing (L1). A start that can't finish by the deadline creates
 * nothing and says so, never handing the write to the existing assistant.
 * Otherwise writes go to the existing assistant as before (L6). A record
 * card offers Edit and Delete for such a module.
 *
 * Increment 8 (spec B1, B9; reads only): a count or named-total breakdown is
 * drawn as a chart (one per currency for a named total), a count of a
 * pipeline module by its stage is the pipeline view, and an agenda across
 * modules ("what's on this week") is read by Daily Events itself (executor
 * D) or module by module (executor Q) by the tenant's Daily Events switch,
 * which is asked only for an agenda or a list Daily Events also shows (its
 * table then offers "Open Daily Events"). A presentation an answer can't use
 * (a chart word on a list or a single number, a pipeline word off a stage
 * breakdown) is answered as well as it can be, with a notice that says what
 * was drawn instead. Bare "pipeline" asks which one. */

const router = Router();

/** The AI service stops waiting for an answer after 4 s
 * (ai/src/agents/crm-assist/engine.ts ASSIST_RESOLVE_TIMEOUT_MS.on) and asks
 * the existing assistant instead, which costs an LLM call. So an answer is
 * due this long after the request reached this route; whatever hasn't
 * finished by then is answered in an error state that can be retried (never
 * a zero, never a hang), or handed to the existing assistant: a message not
 * parsed yet, and a read on executor L (the module's own list(), whose slow
 * reads Increment 1 left to the existing assistant's longer read). /execute
 * answers by the same deadline (the AI service waits 4 s for it too) and
 * never hands anything to the existing assistant. The abandoned reads stop
 * on their own time limits (QUERY_MAX_TIME_MS, CONNECTOR_QUERY_TIME_MS).
 * Tests shorten `ms`. */
export const RESOLVE_DEADLINE = { ms: 3500 };

/** The per-source count ("how many customers do we have") gets its own
 * deadline this much earlier than the answer's: each source still running
 * then becomes a "took too long" tile and the finished ones keep their
 * numbers, before the route's own deadline drops them all. */
const CONCEPT_SOURCE_MARGIN_MS = 150;

/** On an executor L list, whether its Field Service amounts can be sorted
 * (fsRankableOnL) is waited for FS_RANKABLE_BUDGET at most, and never later
 * than this long before the answer's deadline: past that, the amounts are
 * just not sortable and the list is answered. */
const FS_RANKABLE_MARGIN_MS = 100;

/** A record card's related counts are given up this long before the
 * answer's deadline: a count still running then is shown as "took too long",
 * never holding up (or dropping) the card. */
const RELATED_MARGIN_MS = 300;

/** How long the grammar waits for the caller's Custom Modules (their names
 * are module words). Later, this message has none (the read goes on and is
 * cached for the next); tests shorten it. */
export const CUSTOM_MODULES_WAIT = { ms: 1000 };

class DeadlineExceededError extends Error {
  constructor() {
    super('The resolve deadline passed');
    this.name = 'DeadlineExceededError';
  }
}

/** `work`'s result, unless the deadline (epoch ms) passes first: then a
 * DeadlineExceededError. The work is not cancelled; its late result or
 * failure is dropped. */
function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError()), Math.max(0, deadline - Date.now()));
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

type Locals = { crmAssistIdentity?: AssistIdentity; crmAssistTenant?: GatewayTenant; crmAssistStartedAt?: number };

/** When a resolve or execute call reached this router: its answer deadline
 * counts from here, so the identity and tenant reads are inside it. */
function markStart(_req: Request, res: Response, next: NextFunction): void {
  (res.locals as Locals).crmAssistStartedAt = Date.now();
  next();
}

function identityStep(req: Request, res: Response, next: NextFunction): void {
  const identity = verifyAssistIdentity(req.params.tenantId, req);
  if (!identity) { sendError(res, IDENTITY_REQUIRED_MESSAGE, 401); return; }
  (res.locals as Locals).crmAssistIdentity = identity;
  next();
}

async function tenantStep(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const identity = (res.locals as Locals).crmAssistIdentity!;
    const tenant = await loadGatewayTenant(identity.tenantId);
    if (isTenantBlocked(tenant, identity)) { sendError(res, TENANT_INACTIVE_MESSAGE, 403); return; }
    (res.locals as Locals).crmAssistTenant = tenant;
    next();
  } catch (err) { next(err); }
}

/** What a read adds to its route's log line. */
interface ReadLog {
  rows?: number;
  total?: number | null;
  outcome?: string;
  /** The executor a read ran on (L, Q, or M for a Custom Module). */
  executor?: string;
  /** Module keys, for a read that knows them before validation (a Custom Module). */
  modules?: string[];
  /** What the answer was drawn as (Increment 8). */
  view?: 'table' | 'kpi' | 'chart' | 'pipeline' | 'agenda';
  /** The tenant's Daily Events switch, when it was asked (Increment 8; unknown: the read failed or was late). */
  dailyEvents?: 'on' | 'off' | 'unknown';
}

/** The caller's Custom Modules (registry/custom-modules.ts customModulesFor):
 * their access, and the modules only when it is 'ok'. */
type CustomModulesRead = { access: CustomModuleAccess; modules: readonly CustomModuleInfo[] };

/** What every read of one call shares: the caller, their tenant and modules,
 * the gates of any other module a plan touches (a relation's other side, the
 * record a name finds, the module that names a total's rows: one
 * RelatedGate per call, query/relations.ts gateRelated), the record on screen
 * (the record page the browser names, else the session's focus: focusOf),
 * the caller's Custom Modules (read at most once per call: customModules()),
 * whether guided forms may start in this chat (workflowsGate: a record
 * card's Edit and Delete) and the tenant's Daily Events switch for this
 * caller (dailyEventsGate: an agenda's executor, a list's "Open Daily
 * Events"). */
interface ReadRequest {
  identity: AssistIdentity;
  tenant: GatewayTenant;
  view: CapabilityView;
  related: RelatedGate;
  focus: { module: string; id: string } | null;
  customModules: () => Promise<CustomModulesRead>;
  workflows: () => Promise<boolean>;
  dailyEvents: () => Promise<boolean | null>;
}

/** customModulesFor, read at most once per call (a failed read rejects every time it is asked for). */
function customModulesOnce(identity: AssistIdentity, tenant: GatewayTenant): () => Promise<CustomModulesRead> {
  let read: Promise<CustomModulesRead> | null = null;
  return () => {
    if (!read) read = customModulesFor(identity.tenantId, identity, tenant);
    return read;
  };
}

/** The record on screen: the record page the staff member is on (the
 * browser names one only on a record's own page), else the session's focus
 * (the record an earlier card in this chat showed). The page wins, so "invoices
 * for this work order" means the work order in front of them, never an older
 * card's. Only a hint either way: the record is read again under the
 * caller's scope (query/resolve-entity.ts). */
function focusOf(state?: AssistSessionState, client?: ClientContext): { module: string; id: string } | null {
  const focus = client?.focus ?? state?.focus;
  return focus ? { module: focus.module, id: focus.id } : null;
}

function readRequest(
  identity: AssistIdentity, tenant: GatewayTenant, view: CapabilityView, customModules: () => Promise<CustomModulesRead>,
  workflows: () => Promise<boolean>, dailyEvents: () => Promise<boolean | null>, state?: AssistSessionState, client?: ClientContext,
): ReadRequest {
  return {
    identity, tenant, view, related: gateRelated({ identity, tenant }), focus: focusOf(state, client), customModules, workflows, dailyEvents,
  };
}

/** The chat session a guided form belongs to (Increment 6, spec B1): the AI
 * service's, which the backend namespaces under the signed-in user
 * ("<userId>.<the browser's session>", ai/crm-chat.service.ts
 * namespacedSessionId). Any other shape starts and fills nothing. */
function formSession(identity: AssistIdentity, sessionId: string | undefined): string | null {
  return typeof sessionId === 'string' && sessionId.startsWith(`${identity.userId}.`) ? sessionId : null;
}

/** Whether guided forms may start or take typed answers in this call (spec
 * B1): the caller's own chat session, and workflows effective for the tenant
 * and role (operations/workflow-gate.ts: Guided forms and Visual answers on,
 * the engine on). Asked at most once per call and only when something could
 * use it; a failed or late settings read counts as off (fail closed). */
function workflowsGate(identity: AssistIdentity, sessionId: string | undefined, deadline: number): () => Promise<boolean> {
  let effective: Promise<boolean> | null = null;
  return () => {
    if (!effective) {
      effective = formSession(identity, sessionId)
        ? beforeDeadline(isWorkflowsEffective(identity.tenantId, identity.role), deadline).catch(() => false)
        : Promise.resolve(false);
    }
    return effective;
  };
}

/** The tenant's Daily Events switch for this caller (Increment 8, spec B9.1;
 * SUPER_ADMIN always on, as the Daily Events route decides): asked at most
 * once per call, and only for an agenda or a list Daily Events also shows.
 * null when the settings read failed or was late, which is neither on nor
 * off: such a list offers no "Open Daily Events" (fail closed), and an agenda
 * is read on executor Q without saying the switch is off. */
function dailyEventsGate(identity: AssistIdentity, deadline: number): () => Promise<boolean | null> {
  let on: Promise<boolean | null> | null = null;
  return () => {
    if (!on) {
      on = beforeDeadline(isCrmAssistantFeatureEnabled(identity.tenantId, 'dailyEvents', identity.role), deadline).catch((err): null => {
        logger.warn('CRM assist: the Daily Events switch could not be read', { late: err instanceof DeadlineExceededError, error: (err as Error)?.name });
        return null;
      });
    }
    return on;
  };
}

/** The Daily Events switch as the log line names it. */
function switchWord(on: boolean | null): 'on' | 'off' | 'unknown' {
  return on === true ? 'on' : on === false ? 'off' : 'unknown';
}

/** A list waits this long at most, from when it asks (alongside its gate
 * read), for the Daily Events switch: later, its table offers no "Open Daily
 * Events" and is answered as it would be anyway, never held up or timed out
 * for the button. */
const DAILY_EVENTS_LIST_WAIT_MS = 400;

/** A list Daily Events also shows (composeTable's rule, compose.ts): due
 * today or overdue in one of its modules (RECORD_SOURCES). Only such a list
 * asks for the switch; its table offers "Open Daily Events" while it is on. */
function couldOfferDailyEvents(cap: ModuleCap, plan: QueryPlan): boolean {
  return plan.op === 'list' && RECORD_SOURCES.some((d) => d.module === cap.key)
    && (plan.where ?? []).some((cond) => cond.op === 'state' && (cond.v === 'due_today' || cond.v === 'overdue'));
}

/** The first block is a question back (a choice of records, of modules): the answer's path is 'clarify'. */
function isClarify(composed: ComposedAnswer): boolean {
  return composed.blocks[0]?.type === 'clarify';
}

interface ResolveLog extends ReadLog {
  path: 'grammar' | 'planner' | 'clarify' | 'legacy' | 'workflow';
  kind: ResolveResult['kind'];
  reason?: string;
  op?: string;
  modules: string[];
  filterKeys: string[];
}

/** Problem codes only (never the messages, which can quote values). */
function problemCodes(problems: readonly PlanProblem[]): string {
  return [...new Set(problems.map((p) => p.code))].join(',') || 'rejected';
}

function execContextFor(
  identity: AssistIdentity, tenant: GatewayTenant, gate: { scope: DataScope; branchId: string | null },
): ExecContext {
  return {
    tenantId: identity.tenantId,
    identity: { userId: identity.userId, role: identity.role, ...(identity.roleId ? { roleId: identity.roleId } : {}) },
    branchId: gate.branchId,
    scope: gate.scope,
    // Executor Q resolves "today", "this week" and due days in the tenant's timezone.
    timezone: tenant.timezone,
  };
}

/** The names of a total's breakdown values (customer numbers), read under the
 * module the field refers to, with that module's own gates (`gate`): none,
 * so the stored numbers are shown, when the caller can't read it or the read
 * fails. */
async function metricLabels(cap: ModuleCap, plan: QueryPlan, outcome: MetricOutcome, gate: RelatedGate): Promise<Map<string, string>> {
  const by = plan.group?.by;
  const ref = by ? cap.fields.find((f) => f.key === by || f.path === by)?.ref : undefined;
  const keys = outcome.rows.map((row) => row.key).filter((key): key is string => !!key);
  if (!ref || !keys.length) return new Map();
  try {
    return await relatedLabels(gate, ref.module, keys, { keyPath: ref.targetField });
  } catch (err) {
    logger.warn('CRM assist: names for a total\'s rows could not be read', { module: ref.module, error: (err as Error)?.message });
    return new Map();
  }
}

/** Executor Q: scoped Mongo queries (conditions, sorts, top N, breakdowns,
 * named totals). A count and its list run the same conditions, so the count
 * equals the list's total. The plan's relation runs first, under the other
 * module's own gates (query/relations.ts prepareRelation): its keys become
 * extra $and members next to this module's closed scope; one that can't run
 * as asked is answered as such (composeRelationOutcome), reading nothing
 * here. The plan shown and kept is the relation's own (a record found by its
 * name, kept by its _id). null: the tenant was switched off meanwhile.
 *
 * Increment 8 (spec B1): a named total broken down is one chart per currency
 * (up to MAX_CHART_POINTS points each); a count of a pipeline module by its
 * stage is the pipeline view; any other count breakdown is a chart (the
 * composer keeps today's table when there is too little to draw); asked as a
 * table, each stays today's table. A presentation the answer can't use gets
 * the notice that says what was drawn instead (withPresentNotice). */
async function answerOnQ(
  cap: ModuleCap, input: QueryPlan, ctx: ExecContext, env: ComposeEnv, log: ReadLog, req: ReadRequest,
): Promise<ComposedAnswer | null> {
  const rel = await prepareRelation(cap, input, req.related, req.focus);
  if (rel.kind !== 'ready') {
    log.outcome = rel.kind;
    return composeRelationOutcome(cap, input, rel, env);
  }
  const plan = rel.plan;
  const extras = rel.relation ? rel.extras : undefined;
  const relation = relationWords(cap, rel) ?? undefined;
  if (plan.op === 'aggregate' && plan.metrics?.some((m) => 'metric' in m)) {
    const charted = !!plan.group && chartWanted(plan);
    const outcome = await executeQueryMetric(cap, plan, ctx, extras, charted ? { maxBuckets: MAX_CHART_POINTS } : {});
    const labels = await metricLabels(cap, plan, outcome, req.related);
    log.rows = Math.min(outcome.rows.length, charted ? MAX_CHART_POINTS : VIEW_CAPS.rows);
    log.total = outcome.totalGroups;
    log.outcome = 'ok';
    log.view = charted ? 'chart' : plan.group ? 'table' : 'kpi';
    if (charted) return composeMetricCharts(cap, plan, outcome, env, labels, relation);
    return withPresentNotice(composeMetric(cap, plan, outcome, env, labels, relation), plan, plan.group ? 'table' : 'number');
  }
  if (plan.op === 'aggregate' && isPipelinePlan(cap, plan)) {
    const outcome = await executePipeline(cap, plan, ctx, extras);
    log.rows = outcome.rows.length;
    log.total = outcome.total;
    log.outcome = 'ok';
    log.view = 'pipeline';
    return composePipeline(cap, plan, outcome, env, relation);
  }
  if (plan.op === 'aggregate' && chartWanted(plan)) {
    const outcome = await executeChartGroups(cap, plan, ctx, extras);
    log.rows = Math.min(outcome.groups.length, MAX_CHART_POINTS);
    log.total = outcome.total;
    log.outcome = 'ok';
    log.view = 'chart';
    return composeCountChart(cap, plan, outcome, env, relation);
  }
  if (plan.op === 'aggregate') {
    const result = await executeQueryGroups(cap, plan, ctx, extras);
    log.rows = Math.min(result.groups.length, VIEW_CAPS.rows);
    log.total = result.total;
    log.outcome = 'ok';
    log.view = 'table';
    return withPresentNotice(composeGroups(cap, plan, result, env, relation), plan, 'table');
  }
  if (plan.op === 'count') {
    // Stage labels and the branch currency, only to word the conditions; read
    // alongside the count.
    const [{ total, implied, notices }, read] = await Promise.all([
      executeQueryCount(cap, plan, ctx, extras),
      plan.where?.length ? loadReadContext(cap, moduleDefFor(cap), ctx).catch(() => null) : Promise.resolve(null),
    ]);
    log.total = total;
    log.outcome = total === null ? 'unreadable' : 'ok';
    log.view = 'kpi';
    return withPresentNotice(
      composeCount(cap, plan, total, env, { executor: 'Q', implied, notices, ...(relation ? { relation } : {}) }, read), plan, 'number',
    );
  }
  const result = await executeQueryList(cap, plan, ctx, extras);
  log.rows = result.items.length;
  log.total = result.total;
  log.outcome = 'ok';
  log.view = 'table';
  return withPresentNotice(composeList(cap, plan, result, env, {
    executor: 'Q', sort: result.sort, implied: result.implied, notices: result.notices, fsRankable: result.fsRankable,
    ...(relation ? { relation } : {}),
  }), plan, 'table');
}

const RECORD_ID = /^[a-f0-9]{24}$/i;
/** A work order card's start action for an invoice made from it (Increment 7, M26). */
const CREATE_INVOICE_LABEL = 'Create invoice';

/** "Edit <singular>" and "Delete <singular>" on a record card (Increment 6):
 * start actions that open this record's guided form or its delete review, by
 * its _id, with no AI call. Only for a module with guided forms while they
 * may start in this chat, for each operation the form takes (an invoice's or
 * a quotation's delete is refused, so their cards offer Edit alone) and the
 * caller may run (the module's switch, its write and view permissions), and
 * never on a record locked for them (only an administrator changes a locked
 * record). Increment 7 (M26): a work order's card also offers "Create
 * invoice", an invoice made from it, when the caller may create invoices in
 * the chat; a lock on the work order never hides it, and whether it can be
 * invoiced is said when it starts. Each is checked again when it runs
 * (startWorkflow). */
async function recordActionsFor(cap: ModuleCap, record: Record<string, unknown>, req: ReadRequest): Promise<RecordAction[]> {
  const id = record._id === undefined || record._id === null ? '' : String(record._id);
  const wf = WORKFLOW_MODULE_KEYS.has(cap.key) ? workflowModuleFor(cap.key) : undefined;
  if (!RECORD_ID.test(id) || !wf || !(await req.workflows())) return [];
  const { identity, tenant } = req;
  /** The module map's entry for `module` when the caller may run `op` on it from the chat, else null. */
  const permittedDef = async (module: string, op: WriteOp) => {
    const writable = writableModule(module, op);
    if (!writable) return null;
    const access = await checkAccess(identity.tenantId, tenant, identity, writable.def, writable.cap, module, op);
    return access.ok ? writable.def : null;
  };
  const ops = (['update', 'delete'] as const).filter((op) => wf.cap.ops.includes(op));
  const invoices = cap.key === 'workorder' && WORKFLOW_MODULE_KEYS.has('invoice') && !!workflowModuleFor('invoice')?.cap.ops.includes('create');
  const [allowed, invoiceDef] = await Promise.all([
    Promise.all(ops.map(async (op) => {
      const def = await permittedDef(cap.key, op);
      return def ? { op, logModule: def.logModule } : null;
    })),
    invoices ? permittedDef('invoice', 'create') : null,
  ]);
  let permitted = allowed.filter((a): a is NonNullable<typeof a> => a !== null);
  // As the start itself reads it: a lock that can't be read doesn't hide them.
  if (permitted.length && !isAdminIdentity(identity) && isRecordLockModule(permitted[0].logModule)) {
    const lock = await getLockStatus(identity.tenantId, permitted[0].logModule, id).catch(() => null);
    if (lock?.isLocked) permitted = [];
  }
  const singular = lowerLabel(cap.labels.singular);
  const actions = permitted.map(({ op }): RecordAction => ({
    kind: 'start', label: `${op === 'update' ? 'Edit' : 'Delete'} ${singular}`, intent: { v: 1, op, module: cap.key, target: { ref: id } },
  }));
  if (invoiceDef) {
    actions.push({ kind: 'start', label: CREATE_INVOICE_LABEL, intent: { v: 1, op: 'create', module: 'invoice', from: { module: cap.key, ref: id } } });
  }
  return actions;
}

/** One record by its number or by a server-written _id (query/detail.ts):
 * its card with lines, stored totals and related counts (those get their own
 * budget, ending RELATED_MARGIN_MS before the answer's deadline), a choice of
 * each when several the caller can see share the number, or "not found".
 * Increment 6: the card's Edit and Delete (recordActionsFor) are worked out
 * within the same budget; late or failed, the card has none. */
async function answerDetail(
  cap: ModuleCap, plan: QueryPlan, record: { ref: string } | { number: string }, ctx: ExecContext, env: ComposeEnv,
  log: ReadLog, req: ReadRequest, deadline: number,
): Promise<ComposedAnswer> {
  let asked = plan;
  let number: string | null = null;
  let found: DetailRead;
  if ('ref' in record) {
    found = await readRecordByRef(cap, record.ref, ctx);
  } else {
    // Looked up as the models store numbers (upper case, ASCII digits:
    // "9a218c-inv-०००७" is 9A218C-INV-0007), whoever wrote it; the answer
    // and the last plan name what was looked up.
    number = businessNumberOf(record.number)?.number ?? record.number;
    asked = number === record.number ? plan : { ...plan, record: { number } };
    found = await readRecordByNumber(cap, number, ctx);
  }
  log.outcome = found.kind;
  if (found.kind === 'not_found') { log.total = 0; return composeNotFound(cap, asked, number, env); }
  if (found.kind === 'duplicates') {
    log.total = found.matches.length;
    return composeDuplicates(cap, asked, number ?? '', found.matches, found.read, env);
  }
  log.total = 1;
  const budget = deadline - RELATED_MARGIN_MS;
  const [extras, actions] = await Promise.all([
    detailExtrasFor(cap, found, req.related, budget - Date.now()),
    beforeDeadline(recordActionsFor(cap, found.record, req), budget).catch((err): RecordAction[] => {
      logger.warn('CRM assist: a record card\'s Edit and Delete were left out', {
        module: cap.key, late: err instanceof DeadlineExceededError, error: (err as Error)?.message,
      });
      return [];
    }),
  ]);
  // A chart or pipeline word next to one record: the card, and a notice that says so (Increment 8).
  return withPresentNotice(
    composeDetail(cap, asked, found.record, found.read, env, { ...extras, ...(actions.length ? { actions } : {}) }), plan, 'table',
  );
}

/** A plan for one of the caller's Custom Modules (executor M,
 * query/execute-custom.ts): their access (no DataScope: everyone with access
 * sees every record), the module (deleted since: a notice), the plan checked
 * against its current definition, then the read, by the deadline. */
type CustomAnswer = { kind: 'answer'; composed: ComposedAnswer } | { kind: 'refused'; problems: PlanProblem[] } | { kind: 'none' };

async function answerCustom(plan: QueryPlan, req: ReadRequest, log: ReadLog, deadline: number): Promise<CustomAnswer> {
  const module = 'module' in plan.target ? plan.target.module : '';
  log.modules = [module];
  log.executor = 'M';
  const answer = (composed: ComposedAnswer): CustomAnswer => ({ kind: 'answer', composed });
  let custom: CustomModulesRead;
  try {
    custom = await beforeDeadline(req.customModules(), deadline);
  } catch (err) {
    if (err instanceof DeadlineExceededError) { log.outcome = 'deadline'; return answer(composeNotInTime()); }
    logger.warn('CRM assist: Custom Modules could not be read', { error: (err as Error)?.message });
    log.outcome = 'custom_unavailable';
    return answer(composeCustomModulesFailed());
  }
  if (custom.access === 'tenant_inactive') { log.outcome = custom.access; return { kind: 'none' }; }
  if (custom.access !== 'ok') { log.outcome = custom.access; return answer(composeCustomAccess(custom.access)); }
  const info = custom.modules.find((m) => m.key === module);
  if (!info) { log.outcome = 'module_not_found'; return answer(composeCustomModuleMissing()); }
  const checked = validateCustomPlan(plan, info);
  if (!checked.ok) { log.outcome = problemCodes(checked.problems); return { kind: 'refused', problems: checked.problems }; }
  try {
    const outcome = await beforeDeadline(executeCustomPlan(info, checked.plan, { tenantId: req.identity.tenantId, timezone: req.tenant.timezone }), deadline);
    if (outcome.op === 'list') { log.rows = outcome.result.items.length; log.total = outcome.result.total; }
    else if (outcome.op === 'count') log.total = outcome.total;
    else { log.rows = Math.min(outcome.result.groups.length, VIEW_CAPS.rows); log.total = outcome.result.total; }
    // No records because the module was deleted since it was cached: the answer says it no longer exists (D8).
    const gone = outcome.op === 'count' ? outcome.moduleGone : outcome.result.moduleGone;
    log.outcome = gone ? 'module_not_found' : outcome.op === 'count' && outcome.total === null ? 'unreadable' : 'ok';
    return answer(composeCustomAnswer(info, checked.plan, outcome, { timezone: req.tenant.timezone }));
  } catch (err) {
    if (err instanceof PlanRejectedError) { log.outcome = problemCodes(err.problems); return { kind: 'refused', problems: err.problems }; }
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: Custom Module read did not finish in time', { deadlineMs: RESOLVE_DEADLINE.ms });
      log.outcome = 'deadline';
      return answer(composeCustomTimedOut(info, checked.plan));
    }
    logger.warn('CRM assist: Custom Module read failed', { error: (err as Error)?.message });
    log.outcome = 'error';
    return answer(composeCustomQueryFailed(info, checked.plan));
  }
}

function isCustomTarget(plan: QueryPlan): boolean {
  return 'module' in plan.target && isCustomModuleKey(plan.target.module);
}

/** Turns a read plan of the grammar into an answer, under the gates, on the
 * executor validateQueryPlan chose for it (a Custom Module's on executor M),
 * by the deadline. null: the existing assistant answers it. */
async function answerRead(input: QueryPlan, req: ReadRequest, log: ResolveLog, deadline: number): Promise<ComposedAnswer | null> {
  if (isCustomTarget(input)) {
    const custom = await answerCustom(input, req, log, deadline);
    return custom.kind === 'answer' ? custom.composed : null;
  }
  const checked = validateQueryPlan(input, req.view);
  if (!checked.ok) {
    if (checked.access && checked.module) {
      const cap = getModuleCap(checked.module);
      if (cap) { log.outcome = checked.access; return composeModuleState(cap, checked.access); }
    }
    log.outcome = problemCodes(checked.problems);
    return null;
  }
  const { cap, plan, executor } = checked;
  log.executor = executor;
  try {
    return await beforeDeadline(readUnderGates(cap, plan, executor, req, log, deadline), deadline);
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) throw err;
    logger.warn('CRM assist: read did not finish in time', { module: cap.key, op: plan.op, executor, deadlineMs: RESOLVE_DEADLINE.ms });
    log.outcome = 'deadline';
    // Executor L is the module's own list() / getById(): Increment 1 never cut
    // it short (a slow one reached the existing assistant, whose read allows
    // longer), so it goes there now, as an unparsed message does. Executor
    // Q's queries answer in an error state that can be retried.
    if (executor === 'L') return null;
    return composeReadTimedOut(cap, plan);
  }
}

/** The gates for the module the plan targets, then the read on `executor`
 * (`deadline`: the answer's, epoch ms). Any other module the plan touches
 * (a relation's, a total's names, a record card's related counts) goes
 * through its own gates on req.related. A list Daily Events also shows asks
 * for the Daily Events switch alongside the gate read (Increment 8). */
async function readUnderGates(
  cap: ModuleCap, plan: QueryPlan, executor: Executor, req: ReadRequest, log: ReadLog, deadline: number,
): Promise<ComposedAnswer | null> {
  const { identity, tenant, view } = req;
  const def = moduleDefFor(cap);
  const dailyEvents = couldOfferDailyEvents(cap, plan)
    ? beforeDeadline(req.dailyEvents(), Math.min(deadline, Date.now() + DAILY_EVENTS_LIST_WAIT_MS)).catch((): null => null)
    : null;
  // The gates run for the module the plan touches, every time (the view is a cache).
  const gate = await gateModuleRead(identity.tenantId, tenant, identity, {
    flagKey: cap.gate.flagKey, label: def.label, viewPermission: `${cap.gate.permPrefix}.view`, scopeKey: cap.gate.scopeKey,
  });
  if (!gate.ok) {
    log.outcome = gate.reason;
    if (gate.reason === 'tenant_inactive') return null;
    return composeModuleState(cap, gate.reason);
  }

  const env: ComposeEnv = { timezone: tenant.timezone, scopeKind: gate.scope.kind, canViewModule: (m) => view.has(m) };
  if (dailyEvents) {
    const on = await dailyEvents;
    log.dailyEvents = switchWord(on);
    env.dailyEventsOn = on === true;
  }
  const ctx = execContextFor(identity, tenant, gate);
  try {
    if (executor === 'Q') return await answerOnQ(cap, plan, ctx, env, log, req);
    if (plan.op === 'count') {
      const { total } = await executeCount(cap, plan, ctx);
      log.total = total;
      log.outcome = total === null ? 'unreadable' : 'ok';
      log.view = 'kpi';
      return withPresentNotice(composeCount(cap, plan, total, env), plan, 'number');
    }
    if (plan.op === 'detail' && plan.record && !('focus' in plan.record)) {
      return await answerDetail(cap, plan, plan.record, ctx, env, log, req, deadline);
    }
    // Whether its Field Service amounts can be sorted (a sort re-runs on Q),
    // read alongside list() and only when the table has such a column, within
    // its own short budget that ends before the answer's deadline: a slow or
    // failed read only hides that column's sort, never holds up or drops the list.
    const budgetMs = Math.min(FS_RANKABLE_BUDGET.ms, deadline - FS_RANKABLE_MARGIN_MS - Date.now());
    const [result, fsRankable] = await Promise.all([
      executeList(cap, plan, ctx),
      fsRankableOnL(cap, plan, () => fsAmountsRankable(cap, ctx), budgetMs),
    ]);
    log.rows = result.items.length;
    log.total = result.total;
    log.outcome = 'ok';
    log.view = 'table';
    return withPresentNotice(composeList(cap, plan, result, env, { executor: 'L', fsRankable }), plan, 'table');
  } catch (err) {
    // "mine" that can't be told for this caller (no staff profile where the
    // module's rule needs one, or a module with no owner): a notice that says
    // why, never every record.
    if (err instanceof MineUnavailableError) {
      log.outcome = err.code;
      return composeMineUnavailable(cap, plan, err, env);
    }
    // A plan the compiler refuses (an unknown stage value, amounts in more
    // than one currency, ...) is not answered here: resolve hands it to the
    // existing assistant, execute asks again. The problems are logged as
    // codes only.
    if (err instanceof PlanRejectedError) {
      log.outcome = problemCodes(err.problems);
      return null;
    }
    if (err instanceof ScopeFailClosedError) {
      // The caller's scope came out empty: nothing is read, never "everything".
      logger.warn('CRM assist: data scope failed closed', { module: cap.key, op: plan.op, executor });
      log.outcome = 'scope_failed_closed';
      return composeQueryFailed(cap, plan, env);
    }
    logger.warn('CRM assist: read failed', { module: cap.key, op: plan.op, executor, error: (err as Error)?.message });
    log.outcome = 'error';
    return composeQueryFailed(cap, plan, env);
  }
}

/** "How many customers do we have" (the grammar's concept count, or the
 * planner's): one count per source, each under its own gates and in its own
 * state; never added together. With plan.mine ("how many customers do I
 * have") each source counts only the caller's own. */
async function answerConceptCount(
  concept: ConceptKey, plan: QueryPlan,
  identity: AssistIdentity, tenant: GatewayTenant, view: CapabilityView, log: ReadLog, deadline: number,
): Promise<ComposedAnswer> {
  try {
    // The sources are counted side by side (countConcept), each in its own
    // state and each by its own deadline; the report says when the connected
    // CRMs couldn't even be looked up (a warning, never a made-up tile).
    const report: { connectorsUnchecked?: boolean } = {};
    const sections = await beforeDeadline(countConcept({
      concept, tenantId: identity.tenantId, tenant, identity, view,
      deadline: deadline - CONCEPT_SOURCE_MARGIN_MS, report, mine: plan.mine,
    }), deadline);
    const unchecked = report.connectorsUnchecked === true;
    log.outcome = [...sections.map((s) => s.state.status), ...(unchecked ? ['connectors_unchecked'] : [])].join(',') || 'no_sources';
    log.view = 'kpi';
    // A chart or pipeline word: the tiles, and a notice that says so (Increment 8).
    return withPresentNotice(composeConceptCount(concept, plan, sections, { connectorsUnchecked: unchecked }), plan, 'number');
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: concept count did not finish in time', { concept, deadlineMs: RESOLVE_DEADLINE.ms });
      log.outcome = 'deadline';
      return composeConceptTimedOut(concept, plan, (module) => view.accessOf(module));
    }
    logger.warn('CRM assist: concept count failed', { concept, error: (err as Error)?.message });
    log.outcome = 'error';
    return composeConceptFailed(concept);
  }
}

/** "How many Salesforce opportunities": the vendor's stored module, under
 * the connector gates, with its state and freshness. */
async function answerConnectorCount(
  parse: Extract<GrammarParse, { kind: 'connector_count' }>,
  identity: AssistIdentity, tenant: GatewayTenant, log: ResolveLog, deadline: number,
): Promise<ComposedAnswer> {
  try {
    const section = await beforeDeadline(countConnectorModule({
      tenantId: identity.tenantId, tenant, identity, type: parse.connector, request: parse.target,
    }), deadline);
    log.outcome = section.state.status;
    return composeConnectorCount(section);
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: connector count did not finish in time', { type: parse.connector, deadlineMs: RESOLVE_DEADLINE.ms });
      log.outcome = 'deadline';
      return composeConnectorTimedOut(parse.connector, parse.target);
    }
    logger.warn('CRM assist: connector count failed', { type: parse.connector, error: (err as Error)?.message });
    log.outcome = 'error';
    return composeConnectorFailed(parse.connector);
  }
}

/** An agenda's executor Q gives up on a module this long before the
 * answer's deadline: that module is a "took too long" group and the others
 * keep what they read. */
const AGENDA_MODULE_MARGIN_MS = 150;

/** An agenda across modules (Increment 8, spec B9.4: "what's on today",
 * "what's on this week"), checked by its own validator: a window over 3
 * months is said so; any other problem is null (resolve: the existing
 * assistant; execute checks the plan itself first). Read by Daily Events
 * itself (executor D, getDailyEvents unchanged) for today, overdue, the next
 * 7 days and the whole view while the tenant's Daily Events switch is on,
 * else module by module under each one's own gates (executor Q), by the
 * deadline. Late: a notice to try again (an abandoned Daily Events read
 * still fills its own 20 s cache); failed: a notice. A switch that couldn't
 * be read is neither on nor off: the agenda is read on executor Q and never
 * said to be turned off. The log line: the executor, the group modules, the
 * items listed and the read buckets' totals; never a value. */
async function answerAgenda(plan: QueryPlan, req: ReadRequest, log: ReadLog, deadline: number): Promise<ComposedAnswer | null> {
  const { identity, tenant } = req;
  const checked = validateAgendaPlan(plan, tenant.timezone);
  if (!checked.ok) {
    log.outcome = checked.tooLong ? 'too_long' : problemCodes(checked.problems);
    if (!checked.tooLong) return null;
    log.view = 'agenda';
    return composeAgendaTooLong(plan);
  }
  log.view = 'agenda';
  const on = await req.dailyEvents();
  log.dailyEvents = switchWord(on);
  const window = resolveAgendaWindow(checked.plan, tenant.timezone);
  const executor = chooseAgendaExecutor(window, on === true);
  log.executor = executor;
  try {
    const outcome = await beforeDeadline(executor === 'D'
      ? runAgendaD({ identity, tenant, window })
      : runAgendaQ({ identity, tenant, related: req.related, window, moduleDeadline: deadline - AGENDA_MODULE_MARGIN_MS }), deadline);
    const buckets = outcome.groups.flatMap((g) => g.buckets);
    log.modules = [...new Set(outcome.groups.map((g) => g.module))].slice(0, MAX_PARSE_MODULES);
    log.rows = buckets.reduce((n, b) => n + b.items.length, 0);
    log.total = buckets.reduce((n, b) => n + (b.total ?? 0), 0);
    log.outcome = 'ok';
    return composeAgenda(outcome, checked.plan, { dailyEventsOn: on !== false });
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: agenda did not finish in time', { executor, deadlineMs: RESOLVE_DEADLINE.ms });
      log.outcome = 'deadline';
      return composeAgendaTimedOut(checked.plan);
    }
    logger.warn('CRM assist: agenda read failed', { executor, error: (err as Error)?.name });
    log.outcome = 'error';
    return composeAgendaFailed(checked.plan);
  }
}

/** Grammar v1's context for the modules this caller can use (tenant stage
 * words, enum values, sortable and groupable fields, and the Field Service
 * currency of the caller's branch; cached per tenant and branch), and their
 * Custom Modules (`customModules`, whose names are module words). If it can't
 * be loaded, grammar v0's: filtered questions then go to the existing
 * assistant, as before Increment 3. */
async function grammarContextFor(
  identity: AssistIdentity, tenant: GatewayTenant, view: Pick<CapabilityView, 'modules'>, customModules?: readonly CustomModuleInfo[],
): Promise<GrammarContext> {
  try {
    return await loadGrammarContext({
      tenantId: identity.tenantId, timezone: tenant.timezone, modules: view.modules, branchId: identity.branchId,
      ...(customModules ? { customModules } : {}),
    });
  } catch (err) {
    logger.warn('CRM assist: grammar context unavailable; grammar v0 used', { error: (err as Error)?.message });
    return grammarContextFromRegistry();
  }
}

/** The caller's Custom Modules for the grammar and the planner's catalog:
 * only when their access is ok, waiting at most CUSTOM_MODULES_WAIT. Later,
 * or when they can't be read, none for this message (an answer about one
 * still reads them: customModules() is the same read). */
async function customModulesForGrammar(customModules: () => Promise<CustomModulesRead>): Promise<readonly CustomModuleInfo[]> {
  try {
    const read = await beforeDeadline(customModules(), Date.now() + CUSTOM_MODULES_WAIT.ms);
    return read.access === 'ok' ? read.modules : [];
  } catch (err) {
    logger.warn('CRM assist: Custom Modules not read for the grammar', { late: err instanceof DeadlineExceededError, error: (err as Error)?.message });
    return [];
  }
}

/** parse_only replies carry at most this many module keys and filter keys. */
const MAX_PARSE_MODULES = 20;
const MAX_PARSE_FILTER_KEYS = 40;

/** Longer than the planner reads (PLANNER_CAPS, plan 4.10): such a message
 * gets a "too long" clarify instead of the planner's LLM call. */
function tooLongForPlanner(message: string): boolean {
  return message.length > PLANNER_CAPS.messageChars || estimateTokens(message) > PLANNER_CAPS.messageEstTokens;
}

/** The module a plan reads: its target module, or a concept's own module ("customer"). */
function moduleOfPlan(plan: QueryPlan | undefined): string | null {
  if (!plan) return null;
  if ('module' in plan.target) return plan.target.module;
  return getModuleCap(plan.target.concept)?.key ?? null;
}

/** A read the grammar can't fully parse, or a message of a non-English
 * tenant that isn't small talk: the planner gets it, with the catalog of the
 * caller's modules ranked for it (`seeds`: the modules the grammar saw; the
 * session's last plan and the record on screen count too), unless it is
 * longer than the planner reads: that gets a "too long" clarify, with no LLM
 * call. A caller who can read no module at all (no registry module and no
 * Custom Module) gets help that says so, with no LLM call either: no plan of
 * theirs could run. One who reads only Custom Modules gets the planner, with
 * those in the catalog. `form` (Increment 6): the session's open draft, whose
 * module and fields the catalog lists first, so a typed answer can fill it. */
function handToPlanner(
  body: ResolveRequest, tenant: GatewayTenant, view: CapabilityView, grammar: GrammarContext,
  seeds: readonly string[], log: ResolveLog, customModules: readonly CustomModuleInfo[] = [], form: FillFormSpec | null = null,
): ResolveResult {
  if (!view.modules.length && !customModules.length) {
    log.path = 'clarify';
    log.kind = 'answer';
    log.outcome = 'no_modules';
    return finalizeAnswer(composeHelp([]), body.state, 'clarify');
  }
  if (tooLongForPlanner(body.message)) {
    log.path = 'clarify';
    log.kind = 'answer';
    log.outcome = 'too_long';
    return finalizeAnswer(composeTooLong({ view, message: body.message, grammar }), body.state, 'clarify');
  }
  log.path = 'planner';
  log.kind = 'needs_planner';
  log.reason = 'needs_planner';
  return {
    kind: 'needs_planner',
    catalog: buildPlannerCatalog({
      message: body.message, view, grammar, timezone: tenant.timezone,
      seeds: { modules: seeds.filter((module) => view.has(module) || customModules.some((m) => m.key === module)) },
      lastPlanModule: moduleOfPlan(body.state?.lastPlan),
      focusModule: focusOf(body.state, body.clientContext)?.module ?? null,
      ...(customModules.length ? { customModules } : {}),
      ...(form ? { form: plannerFormOf(form) } : {}),
    }),
    modules: log.modules,
    filterKeys: log.filterKeys,
  };
}

/* ── Guided forms (Increment 6) ────────────────────────────────────────
 * Shared by resolve and execute: the answer to a step of a guided form
 * (operations/workflow.service.ts, composed by views/compose-form.ts
 * composeWorkflowAnswer) and the open form a typed answer belongs to (spec
 * B12.9; its fields go to the planner as planner-catalog.ts plannerFormOf
 * lists them). */

/** B20 texts this file shows itself. */
const REVIEW_PENDING_MESSAGE = 'This change is waiting for your review. Press Edit to change it.';
const ALREADY_IN_REVIEW_MESSAGE = 'This change is already waiting for your review below.';
const FORM_TIMEOUT_MESSAGE = "I couldn't open the form in time. Try again.";
const FORM_FAILED_MESSAGE = "That didn't work. Try again in a moment.";

/** A guided form's answer: a form, a review, a result or a notice (path 'workflow'), or a choice of records ('clarify'). */
type FormAnswer = { composed: ComposedAnswer; path: 'workflow' | 'clarify' };

function formNotice(code: string, text: string, tone: NoticeBlock['tone'] = 'info'): FormAnswer {
  const { composed } = composeWorkflowAnswer({ kind: 'notice', notice: workflowNotice(code, text, tone) })!;
  return { composed, path: 'workflow' };
}

/** A reply as the log line names it: its kind, a notice's code, a refusal's status. Never a value. */
function replyOutcome(reply: WorkflowReply): string {
  if (reply.kind === 'notice') return reply.notice.code;
  return reply.kind === 'refused' ? `refused_${reply.http}` : reply.kind;
}

/** A start the answer gave up on (FORM_TIMEOUT) that still finishes: it got
 * past its own deadline check, but its writes were slow. The form or delete
 * review it opened was never shown, so it is cancelled as the same caller
 * (cancelWorkflow writes the 'cancelled' audit entry) and nothing the person
 * never saw stays open in their chat (L2). A start that fails late created
 * nothing; its failure is dropped as before. Logs ids and keys only. */
function cancelLateStart(running: Promise<WorkflowReply>, caller: WorkflowCaller): void {
  running.then(async (late) => {
    if (late.kind !== 'form' && late.kind !== 'review') return;
    const cancelled = await cancelWorkflow(late.operationId, caller);
    logger.warn('CRM assist: a guided form that opened after its answer timed out was cancelled', {
      operationId: late.operationId, module: late.block.module, status: cancelled.kind === 'result' ? cancelled.block.status : replyOutcome(cancelled),
    });
  }, () => undefined).catch((err) => {
    logger.warn('CRM assist: a guided form that opened after its answer timed out could not be cancelled', { error: (err as Error)?.message });
  });
}

/** The answer to a step of a guided form, by the answer's deadline. A start
 * that hasn't finished by then says FORM_TIMEOUT (it creates nothing that
 * late, B12.1, and what it opens once the answer has been given is cancelled
 * as `caller`: cancelLateStart), any other step "not in time"; a step that
 * fails says FORM_FAILED. Neither goes to the existing assistant. null:
 * not_workflow (the module has no guided form for this operation): the
 * caller answers as before Increment 6. */
async function workflowAnswer(
  step: 'start' | 'fill' | 'cancel' | 'review', work: () => Promise<WorkflowReply>, deadline: number, log: ReadLog,
  caller?: WorkflowCaller,
): Promise<FormAnswer | null> {
  let running: Promise<WorkflowReply> | undefined;
  let reply: WorkflowReply;
  try {
    running = work();
    reply = await beforeDeadline(running, deadline);
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: a guided form step did not finish in time', { step, deadlineMs: RESOLVE_DEADLINE.ms });
      log.outcome = 'deadline';
      if (step !== 'start') return { composed: composeNotInTime(), path: 'workflow' };
      if (running && caller) cancelLateStart(running, caller);
      return formNotice('form_timeout', FORM_TIMEOUT_MESSAGE, 'warning');
    }
    logger.warn('CRM assist: a guided form step failed', { step, error: (err as Error)?.message });
    log.outcome = 'error';
    return formNotice('form_failed', FORM_FAILED_MESSAGE, 'warning');
  }
  log.outcome = replyOutcome(reply);
  const answered = composeWorkflowAnswer(reply);
  return answered ? { composed: answered.composed, path: answered.path } : null;
}

/** The session's open form a typed answer belongs to (spec B12.9): the
 * caller's own operation the hint names (the browser's, else the session
 * state's), bound as a draft, or one whose review card is open (L1:
 * `staged`), with its fields for the fill reader (a delete's review has no
 * fields: only cancel and review read). null when there is none, or it
 * can't be read in time: the message is then read as before. */
interface OpenForm { operationId: string; staged: boolean; spec: FillFormSpec }

async function openFormFor(caller: WorkflowCaller, hint: string | undefined, deadline: number): Promise<OpenForm | null> {
  if (!hint) return null;
  try {
    return await beforeDeadline((async (): Promise<OpenForm | null> => {
      const bound = await bindFill(caller.identity, caller.sessionId, hint);
      if (bound.ok) {
        const spec = await formSpecFor(bound.operationId, caller);
        return spec ? { operationId: bound.operationId, staged: false, spec } : null;
      }
      if (bound.reason !== 'not_draft' || bound.status !== 'staged') return null;
      const spec = await formSpecFor(hint, caller);
      return { operationId: hint, staged: true, spec: spec ?? { module: bound.module ?? '', op: 'update', fields: [] } };
    })(), deadline);
  } catch (err) {
    logger.warn('CRM assist: the open form could not be read', { late: err instanceof DeadlineExceededError, error: (err as Error)?.message });
    return null;
  }
}

/** "review" typed while the review card is open (L1: nothing changes):
 * ALREADY_IN_REVIEW with that card and its confirmation again below it, so a
 * review staged after its answer was given ("not in time") can still be
 * confirmed. One that changed meanwhile answers as it is now (its form after
 * an Edit, or its result card); one that can't be read in time, the notice
 * alone. */
async function reviewShownAgain(operationId: string, caller: WorkflowCaller, deadline: number, log: ReadLog): Promise<FormAnswer> {
  const notice = formNotice('review_pending', ALREADY_IN_REVIEW_MESSAGE);
  log.outcome = 'review_pending';
  let current: WorkflowReply;
  try {
    current = await beforeDeadline(workflowStatus(operationId, caller), deadline);
  } catch (err) {
    logger.warn('CRM assist: the open review could not be read', { late: err instanceof DeadlineExceededError, error: (err as Error)?.message });
    return notice;
  }
  const answered = composeWorkflowAnswer(current);
  if (!answered) return notice;
  if (current.kind !== 'review') {
    log.outcome = replyOutcome(current);
    return { composed: answered.composed, path: answered.path };
  }
  const composed = { ...answered.composed, blocks: [...notice.composed.blocks, ...answered.composed.blocks], summary: notice.composed.summary };
  return { composed, path: 'workflow' };
}

/** A typed answer the fill reader (grammar/write.ts parseFill) takes whole,
 * for the session's open form: cancel it, send it for review, or fill it in
 * (origin suggested, applyFill). While its review card is open (L1) only
 * cancel runs: typed values never change a reviewed change; Edit on the card
 * does, and "review" shows the card again. null: not an answer for the form,
 * read as before. */
async function answerTypedAnswer(
  open: OpenForm, message: string, grammar: GrammarContext, caller: WorkflowCaller, deadline: number, log: ReadLog,
): Promise<FormAnswer | null> {
  const read = parseFill(message, open.spec, grammar);
  if (!read) return null;
  const { operationId } = open;
  if (read.kind === 'cancel') return workflowAnswer('cancel', () => cancelWorkflow(operationId, caller), deadline, log);
  if (open.staged) {
    if (read.kind === 'review') return reviewShownAgain(operationId, caller, deadline, log);
    log.outcome = 'review_pending';
    return formNotice('review_pending', REVIEW_PENDING_MESSAGE);
  }
  if (read.kind === 'review') return workflowAnswer('review', () => reviewDraft(operationId, { revision: 'latest' }, caller), deadline, log);
  const { values, refs, fieldNotes } = read;
  return workflowAnswer('fill', () => applyFill(operationId, { values, refs, source: 'grammar', fieldNotes }, caller), deadline, log);
}

/** What resolve's guided forms need of the call. */
interface FormsRun {
  body: ResolveRequest;
  identity: AssistIdentity;
  tenant: GatewayTenant;
  view: CapabilityView;
  grammar: GrammarContext;
  custom: readonly CustomModuleInfo[];
  log: ResolveLog;
  deadline: number;
  url: string;
  workflows: () => Promise<boolean>;
}

function resolvedForm(answered: FormAnswer, previous: AssistSessionState | undefined, log: ResolveLog): ResolveResult {
  log.path = answered.path;
  log.kind = 'answer';
  return finalizeAnswer(answered.composed, previous, answered.path);
}

/** Resolve's guided forms (spec B1, B12.9), before its other routes, for
 * the caller's own chat session while workflows are effective:
 *  - a typed answer (a read the grammar can't parse, a write that names no
 *    module, any message of a non-English tenant) while the session's form
 *    is open: a fill, cancel or review the fill reader takes whole is
 *    answered here (never for a non-English message, D17); otherwise the
 *    message is read as before, and the planner, when it gets it, also gets
 *    the open draft's fields (`form`);
 *  - write wording for one of the 22 modules with a guided form, as the
 *    write grammar reads it: the form, or a delete's review, with no AI call
 *    (a new write replaces the session's open form, L2); a read worded like a
 *    write (L4) or a write the grammar can't be sure of goes to the planner.
 * Writes for other modules, configuration wording and anything while
 * workflows are off are answered as before (the existing assistant, L6). */
async function resolveForms(run: FormsRun, parse: GrammarParse | null): Promise<{ answer: ResolveResult } | { form: FillFormSpec | null }> {
  const { body, identity, tenant, log, deadline } = run;
  const sessionId = formSession(identity, body.sessionId);
  if (!sessionId) return { form: null };
  const caller: WorkflowCaller = { identity, tenant, sessionId, url: run.url };
  let form: FillFormSpec | null = null;
  const typed = !parse
    || (parse.kind === 'legacy' && (parse.reason === 'needs_planner' || (parse.reason === 'write' && !parse.modules.length)));
  const hint = body.clientContext?.operationId ?? body.state?.operationId;
  if (typed && hint && await run.workflows()) {
    const open = await openFormFor(caller, hint, deadline);
    const answered = open && parse ? await answerTypedAnswer(open, body.message, run.grammar, caller, deadline, log) : null;
    if (answered) return { answer: resolvedForm(answered, body.state, log) };
    if (open && !open.staged) form = open.spec;
  }
  if (!parse || parse.kind !== 'legacy' || parse.reason !== 'write') return { form };
  const write = parseWriteIntent(body.message, parse, run.grammar);
  if (write.kind === 'not_workflow' || !(await run.workflows())) return { form };
  if (write.kind !== 'intent') {
    log.outcome = write.kind;
    return { answer: handToPlanner(body, tenant, run.view, run.grammar, parse.modules, log, run.custom, form) };
  }
  const answered = await workflowAnswer('start', () => startWorkflow({
    intent: write.intent, source: 'grammar', notTaken: write.notTaken, fieldNotes: write.fieldNotes,
    focus: focusOf(body.state, body.clientContext), deadline,
  }, caller), deadline, log, caller);
  return answered ? { answer: resolvedForm(answered, body.state, log) } : { form };
}

async function resolve(
  body: ResolveRequest, identity: AssistIdentity, tenant: GatewayTenant, log: ResolveLog, deadline: number, url: string,
): Promise<ResolveResult> {
  // Decision D17: the grammar and its texts are English-only, so a message
  // from a tenant whose assistant speaks another language is not read as a
  // question: it goes to the planner whole (the planner reads any language),
  // the way a read the grammar can't parse does. Small talk alone (a
  // greeting, thanks, goodbye or a request for help, parseSmallTalk) is
  // answered as for English, with no AI call. Shadow mode only reports that.
  const english = isEnglishLanguage(tenant.language);
  if (!english && body.mode === 'parse_only') {
    log.kind = 'parse_only';
    const small = parseSmallTalk(body.message, grammarContextFromRegistry());
    if (small) {
      log.path = 'grammar';
      log.op = small.op;
      return { kind: 'parse_only', path: 'grammar', op: small.op, modules: [], filterKeys: [] };
    }
    log.path = 'planner';
    log.reason = 'needs_planner';
    log.outcome = 'non_english';
    return { kind: 'parse_only', path: 'planner', reason: 'needs_planner', modules: [], filterKeys: [] };
  }

  // The grammar parses against the caller's own modules (the capability view
  // is cached for 60 s) and Custom Modules (read once per call, cached 60 s
  // per tenant); parse_only does the same, so shadow logs what engine=on
  // would do. Neither reads a record before the dispatch below.
  const customModules = customModulesOnce(identity, tenant);
  const setup = (async () => {
    const [caps, custom] = await Promise.all([
      getCapabilityView(identity.tenantId, identity, tenant), customModulesForGrammar(customModules),
    ]);
    const grammar = await grammarContextFor(identity, tenant, caps, custom);
    return { view: caps, grammar, custom, parse: english ? parseMessage(body.message, grammar) : parseSmallTalk(body.message, grammar) };
  })();
  let view: CapabilityView;
  let grammar: GrammarContext;
  let custom: readonly CustomModuleInfo[];
  let parse: GrammarParse | null;
  try {
    // parse_only is unchanged; an answer can't wait past the deadline.
    ({ view, grammar, custom, parse } = body.mode === 'parse_only' ? await setup : await beforeDeadline(setup, deadline));
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) throw err;
    // The question isn't even parsed: the existing assistant takes it now
    // instead of after the AI service's own timeout.
    logger.warn('CRM assist: the grammar was not ready in time', { deadlineMs: RESOLVE_DEADLINE.ms });
    log.path = 'legacy';
    log.kind = 'legacy';
    log.reason = 'unsupported';
    log.outcome = 'deadline';
    return { kind: 'legacy', reason: 'unsupported' };
  }
  // Whether guided forms may start in this chat (Increment 6): asked once, only when something needs it.
  const workflows = workflowsGate(identity, body.sessionId, deadline);
  const forms: FormsRun = { body, identity, tenant, view, grammar, custom, log, deadline, url, workflows };
  // A non-English message that isn't small talk: nothing parsed, nothing to seed the ranking with (the session's
  // open draft, if any, goes along with its fields).
  if (!parse) {
    log.outcome = 'non_english';
    const open = await resolveForms(forms, null);
    return 'answer' in open ? open.answer : handToPlanner(body, tenant, view, grammar, [], log, custom, open.form);
  }
  log.op = parse.op;
  log.modules = parse.modules.slice(0, MAX_PARSE_MODULES);
  log.filterKeys = parse.filterKeys.slice(0, MAX_PARSE_FILTER_KEYS);
  const unparsed = parse.kind === 'legacy' && parse.reason === 'needs_planner';

  if (body.mode === 'parse_only') {
    const path = unparsed ? 'planner' : parse.kind === 'legacy' ? 'legacy' : 'grammar';
    log.path = path;
    log.kind = 'parse_only';
    if (parse.kind === 'legacy') log.reason = parse.reason;
    return {
      kind: 'parse_only',
      path,
      ...(parse.kind === 'legacy' ? { reason: parse.reason } : {}),
      ...(parse.op ? { op: parse.op } : {}),
      modules: log.modules,
      filterKeys: log.filterKeys,
    };
  }
  // Guided forms first (spec B1, B12.9): a typed answer for the session's open form, or a write it takes.
  const written = await resolveForms(forms, parse);
  if ('answer' in written) return written.answer;
  if (unparsed) return handToPlanner(body, tenant, view, grammar, parse.modules, log, custom, written.form);

  const req = readRequest(identity, tenant, view, customModules, workflows, dailyEventsGate(identity, deadline), body.state, body.clientContext);
  let composed: ComposedAnswer | null = null;
  if (parse.kind === 'greeting') composed = composeGreeting(parse.variant);
  else if (parse.kind === 'help') composed = composeHelp(view.modules);
  else if (parse.kind === 'read' || parse.kind === 'detail') composed = await answerRead(parse.plan, req, log, deadline);
  else if (parse.kind === 'ambiguous_module') composed = await answerAmbiguousModule(parse, req, log, deadline);
  else if (parse.kind === 'concept_count') composed = await answerConceptCount(parse.concept, parse.plan, identity, tenant, view, log, deadline);
  else if (parse.kind === 'connector_count') composed = await answerConnectorCount(parse, identity, tenant, log, deadline);
  else if (parse.kind === 'agenda') composed = await answerAgenda(parse.plan, req, log, deadline);

  if (!composed) {
    const reason = parse.kind === 'legacy' ? parse.reason : 'unsupported';
    log.path = 'legacy';
    log.kind = 'legacy';
    log.reason = reason;
    return { kind: 'legacy', reason };
  }
  // A question back (which record, which module) is a clarify answer, still with no AI call.
  const path = isClarify(composed) ? 'clarify' : 'grammar';
  log.path = path;
  log.kind = 'answer';
  return finalizeAnswer(composed, body.state, path);
}

/** A word that names a built-in module and one of the caller's Custom
 * Modules ("equipment"): the same read on each the caller can use, as
 * choices (each re-run with no LLM call); with only one of them usable, that
 * one is simply read. Bare "pipeline" (Increment 8) is the same, asked as
 * "Which pipeline do you mean?" over the caller's pipeline modules. null:
 * the existing assistant answers. */
async function answerAmbiguousModule(
  parse: Extract<GrammarParse, { kind: 'ambiguous_module' }>, req: ReadRequest, log: ResolveLog, deadline: number,
): Promise<ComposedAnswer | null> {
  let customs: readonly CustomModuleInfo[] = [];
  try {
    const read = await beforeDeadline(req.customModules(), deadline);
    customs = read.access === 'ok' ? read.modules : [];
  } catch {
    customs = [];
  }
  const choices: Array<{ plural: string; group: string; plan: QueryPlan; by?: string }> = [];
  parse.candidates.forEach((module, i) => {
    const plan = parse.plans[i];
    if (!plan) return;
    // "how many customers" is the customer concept (D1): each source counted
    // under its own gates (answerConceptCount), so it is offered as such.
    if ('concept' in plan.target) {
      if (isConceptKey(plan.target.concept)) choices.push({ plural: CONCEPTS[plan.target.concept].plural, group: 'by source', plan });
      return;
    }
    const info = isCustomModuleKey(module) ? customs.find((m) => m.key === module) : undefined;
    const cap = info ? undefined : getModuleCap(module);
    // A breakdown is worded by its field's own label (decision D3), which only the definitions hold.
    const by = info && plan.group ? customFieldFor(info, plan.group.by)?.label : undefined;
    if (info) choices.push({ plural: info.name, group: SOURCE_LABELS.custom_module, plan, ...(by ? { by } : {}) });
    else if (cap && req.view.has(cap.key)) choices.push({ plural: cap.labels.plural, group: groupLabel(cap), plan });
  });
  log.outcome = `ambiguous_module:${choices.length}`;
  if (!choices.length) return null;
  if (choices.length === 1) {
    const { plan } = choices[0];
    if ('concept' in plan.target && isConceptKey(plan.target.concept)) {
      return answerConceptCount(plan.target.concept, plan, req.identity, req.tenant, req.view, log, deadline);
    }
    return answerRead(plan, req, log, deadline);
  }
  return composeAmbiguousModule(choices, parse.question === 'pipeline' ? PIPELINE_QUESTION : undefined);
}

router.post('/:tenantId/resolve', markStart, identityStep, tenantStep, crmAssistInternalRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    const { crmAssistIdentity: identity, crmAssistTenant: tenant, crmAssistStartedAt } = res.locals as Locals;
    const started = crmAssistStartedAt ?? Date.now();
    try {
      const body = ResolveRequestSchema.safeParse(req.body);
      if (!body.success) {
        const issue = body.error.issues[0];
        sendError(res, `Invalid resolve request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? 'is invalid'}`.trim(), 400);
        return;
      }
      if (isModuleFlagDisabled(tenant!.flags, 'bot_enabled', identity!.role)) {
        sendError(res, moduleDisabledMessage('The CRM assistant'), 403);
        return;
      }
      const log: ResolveLog = { path: 'legacy', kind: 'legacy', modules: [], filterKeys: [] };
      const result = await resolve(body.data, identity!, tenant!, log, started + RESOLVE_DEADLINE.ms, req.originalUrl);
      logger.info('CRM assist resolve', {
        tenantId: identity!.tenantId, userId: identity!.userId, mode: body.data.mode ?? 'answer',
        path: log.path, kind: log.kind, reason: log.reason, op: log.op, modules: log.modules, filterKeys: log.filterKeys,
        executor: log.executor, rows: log.rows, total: log.total, outcome: log.outcome, view: log.view, dailyEvents: log.dailyEvents,
        durationMs: Date.now() - started, llmCalls: 0,
      });
      sendSuccess(res, result, 'OK');
    } catch (err) {
      next(err);
    }
  });

/* ── Execute (Increment 4) ─────────────────────────────────────────────
 * POST /:tenantId/execute — what the AI service sends after the planner's
 * one LLM call, or instead of it, and a clarify choice's plan:
 *   planner   the planner's tool arguments, checked here only: at most 16 KB
 *             and PlannerOutputSchema (strict, so no identity key can ride
 *             along). A query first loses what changes nothing (plannerPlan:
 *             an empty metrics list, paging on a count, "mine" next to a
 *             record number, a named total's page size read as its top N,
 *             ...); one naming a record by its _id (record { ref }: only
 *             this server writes one) goes to the classic assistant. Its
 *             free text and numbers are then grounded in the message, and
 *             for a follow-up in the session's last plan of the
 *             same module (planner-grounding.ts; what isn't there is left
 *             out, a number read without what the message writes next to it
 *             is corrected, and both are said so; a relation's record name
 *             that isn't in the message refuses the whole plan, decision WB2:
 *             the classic assistant, nothing read), then it takes the
 *             grammar's own path: validation against the caller's view (a
 *             Custom Module's against its definition, executor M), the
 *             gates, the executor, the composer (a Field Service amount the
 *             message writes in another currency than the caller's goes to
 *             the classic assistant). A write intent for one of the 22
 *             modules with a guided form, while workflows are effective
 *             (Increment 6), is grounded in the message (groundWriteIntent)
 *             and opens its form or a delete's review; any other write
 *             intent gets "Use the classic assistant". A fill is bound to
 *             the session's own draft form (bindFill), grounded
 *             (groundFill) and applied to it; while its review card is
 *             open it changes nothing (L1). The planner's own question (each
 *             option sent back with the question as first asked) and "not
 *             about this CRM" become clarify blocks.
 *   run_plan  a clarify choice's plan, written by this server: no grounding,
 *             otherwise the same path, re-run as the caller.
 *   start     a clarify choice's or a record card's write intent, written by
 *             this server (Increment 6): its guided form or delete review,
 *             no grounding (startWorkflow checks it all again as the
 *             caller); while workflows are off, a notice that says so.
 *   fallback  no usable planner answer (the governor or the provider
 *             refused, the output couldn't be read): the clarify for the
 *             reason, with the wait when the AI service knows it.
 * Same gates, in the same order, as resolve; a message is required with
 * planner and fallback (400). The answer is always kind 'answer', by the
 * resolve deadline: data or a notice (meta.path 'planner', or 'action' for a
 * choice's plan), a guided form, review or result ('workflow'), or a clarify
 * block alone ('clarify'). Only a plan to read
 * needs the caller's modules: when they weren't read in time, or the read
 * failed, it answers "not in time" and anything else is answered without
 * them. Nothing here calls a model or hands the message to the existing
 * assistant: what can't run is a clarify (needs_classic for what this engine
 * can't do yet, not_understood for a plan that is wrong). One log line per
 * call: keys and counts only, never a value. */

/** The planner's arguments may take this much JSON (its 1,000-token completion is far less). */
const MAX_PLANNER_OUTPUT_BYTES = 16 * 1024;

/** Problems that mean "this engine can't run that yet" (relations, date
 * windows, agendas, charts, other metrics): the classic assistant may.
 * Any other problem means the plan itself was wrong. */
const NOT_YET_CODES: ReadonlySet<PlanProblemCode> = new Set<PlanProblemCode>(['unsupported_option', 'unsupported_target', 'unsupported_op']);

/** Plan keys a per-source concept count honours: the target, "mine" and a presentation. */
const CONCEPT_COUNT_KEYS: ReadonlySet<string> = new Set(['v', 'op', 'target', 'mine', 'present']);

interface ExecuteLog extends ReadLog {
  path: AnswerPath;
  /** The planner output's kind ('invalid' when it couldn't be read). */
  plannerKind?: string;
  modules: string[];
  filterKeys: string[];
  /** How many values grounding left out. */
  dropped: number;
  /** How many numbers grounding corrected ("5" of "5 lakh" read as 500000). */
  fixed: number;
}

/** One execute call: the caller, their tenant and modules (null when those
 * weren't read in time, or `viewFailed` when the read failed), the request,
 * the message as typed ('' for a choice's plan), the log line, the answer's
 * deadline, the caller's Custom Modules (read only for a plan about one, at
 * most once), the request's URL (a guided form's caller) and whether guided
 * forms may start in this chat (workflowsGate, asked at most once). */
interface ExecuteRun {
  identity: AssistIdentity;
  tenant: GatewayTenant;
  view: CapabilityView | null;
  viewFailed?: boolean;
  body: ExecuteRequest;
  message: string;
  log: ExecuteLog;
  deadline: number;
  customModules: () => Promise<CustomModulesRead>;
  url: string;
  workflows: () => Promise<boolean>;
}

type Executed = { composed: ComposedAnswer; path: AnswerPath };

const clarified = (composed: ComposedAnswer): Executed => ({ composed, path: 'clarify' });

function clarifyContext(run: ExecuteRun): ClarifyContext {
  return { view: run.view, message: run.message };
}

function isConceptKey(value: string): value is ConceptKey {
  return Object.prototype.hasOwnProperty.call(CONCEPTS, value);
}

/** The per-source count can honour this plan: nothing but the target, "mine"
 * and a presentation (Increment 8: any; a chart or pipeline word gets the
 * tiles and a notice that says so, answerConceptCount). */
function runsAsConceptCount(plan: QueryPlan): boolean {
  return Object.entries(plan).every(([key, value]) => value === undefined || CONCEPT_COUNT_KEYS.has(key));
}

/** The module has this field (a planner may put anything in a key). */
function hasField(cap: ModuleCap | null, key: string): boolean {
  return !!cap?.fields.some((f) => f.key === key);
}

function notYet(problems: readonly PlanProblem[], plan: QueryPlan, cap: ModuleCap | null): boolean {
  // A sort or a breakdown by a field the module doesn't have is a wrong
  // plan, not one this engine can't run yet.
  const wrongField = (p: PlanProblem): boolean => (p.path === 'sort.by' && !!plan.sort && !hasField(cap, plan.sort.by))
    || (p.path === 'group.by' && !!plan.group && !hasField(cap, plan.group.by));
  if (problems.some((p) => NOT_YET_CODES.has(p.code) && !wrongField(p))) return true;
  // A connector's records ("connector:zoho:Deals") arrive in a later
  // increment, and a Custom Module key the app can't make
  // ("custom:site_visits"); the classic assistant reads them today.
  return 'module' in plan.target && plan.target.module.includes(':') && problems.some((p) => p.code === 'unknown_module');
}

/** The plan's filter keys for the log line: its fields (only ones the module
 * has: a planner may put anything in a key), states, outcomes and the other
 * parts it uses. Never a value. */
function filterKeysOf(cap: ModuleCap | null, plan: QueryPlan): string[] {
  const keys = new Set<string>();
  for (const cond of plan.where ?? []) {
    if ('f' in cond) keys.add(hasField(cap, cond.f) ? cond.f : 'field');
    else keys.add(cond.op);
  }
  if (plan.search !== undefined) keys.add('search');
  if (plan.mine) keys.add('mine');
  if (plan.sort) keys.add('sort');
  if (plan.group) keys.add('group');
  if (plan.record) keys.add('record');
  if (plan.relation) keys.add('relation');
  return [...keys].sort().slice(0, MAX_PARSE_FILTER_KEYS);
}

/** The planner's tool arguments, when they are a valid planner output of at most 16 KB. */
function readPlannerOutput(raw: unknown): PlannerOutput | null {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? '');
  } catch {
    return null;
  }
  if (size > MAX_PLANNER_OUTPUT_BYTES) return null;
  const parsed = PlannerOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `wait`: whose limit refused the planner and about when a new question can run, when the AI service knows. */
function fallbackClarify(reason: ExecuteFallback, ctx: ClarifyContext, wait?: ExecuteFallbackWait): ComposedAnswer {
  switch (reason) {
    case 'planner_busy': return composePlannerBusy(ctx, wait);
    case 'planner_unavailable': return composePlannerUnavailable(ctx, wait);
    default: return composeNotUnderstood(ctx);
  }
}

/** The most rows a named total's breakdown may be cut to (the plan contract's top). */
const METRIC_TOP_MAX = 50;

/** A planner query without what changes nothing but would be refused as
 * "not supported yet": metrics that are empty or a plain count on a list or
 * a count; top N, paging and a sort on a count; a blank search; "mine" next
 * to a record number (the number names one record, and the caller's scope
 * decides whether they see it). A named total broken down ("top 5 customers
 * by outstanding") is cut by top N only: a page size is its N (the prompt
 * offers pageSize, not top), and paging and a sort largest first are dropped
 * (its rows already come largest first). An ascending sort ("the 5 who owe
 * least") is left for the validator to refuse: the rows can't be read that
 * way. A plain count of customers is the per-source count, as the grammar
 * answers "how many customers". */
function plannerPlan(input: QueryPlan): QueryPlan {
  const plan: QueryPlan = { ...input };
  const metrics = plan.metrics;
  if ((plan.op === 'list' || plan.op === 'count') && metrics && metrics.length <= 1 && metrics.every((m) => 'fn' in m && m.fn === 'count')) {
    delete plan.metrics;
  }
  if (plan.op === 'count') {
    delete plan.top;
    delete plan.page;
    delete plan.pageSize;
    delete plan.sort;
  }
  if (plan.op === 'aggregate' && plan.group && metrics?.some((m) => 'metric' in m) && plan.sort?.dir !== 'asc') {
    if (plan.top === undefined && plan.pageSize !== undefined) plan.top = Math.min(Math.max(plan.pageSize, 1), METRIC_TOP_MAX);
    delete plan.pageSize;
    delete plan.page;
    delete plan.sort;
  }
  if (plan.search !== undefined && !plan.search.trim()) delete plan.search;
  if (plan.op === 'detail') delete plan.mine;
  if (plan.op === 'count' && 'module' in plan.target && plan.target.module === 'customer' && runsAsConceptCount(plan)) {
    plan.target = { concept: 'customer' };
  }
  return plan;
}

/** A date as a condition writes it. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A planner condition asking for one day with eq ("tasks due on 5
 * November" as dueDate eq "2026-11-05") means that whole day, as the
 * grammar writes it: between the day and itself; among the plan's own
 * conditions, and among a has / has_none relation's on its related module's
 * fields ("customers with invoices due on 5 November"). ne has no such
 * meaning and stays refused. (A date object on eq never gets here: the
 * schema refuses it.) */
function withWholeDays(cap: ModuleCap, plan: QueryPlan): QueryPlan {
  let changed = false;
  const wholeDays = (module: ModuleCap, conds: Cond[] | undefined): Cond[] | undefined => conds?.map((cond): Cond => {
    if (!('f' in cond) || cond.op !== 'eq' || typeof cond.v !== 'string') return cond;
    const day = cond.v.trim();
    const kind = module.fields.find((f) => f.key === cond.f)?.kind;
    if (!ISO_DAY.test(day) || (kind !== 'date' && kind !== 'datetime')) return cond;
    changed = true;
    return { f: cond.f, op: 'between', v: [{ date: day }, { date: day }] };
  });
  const where = wholeDays(cap, plan.where);
  let relation = plan.relation;
  if (relation && relation.kind !== 'for') {
    // has / has_none name the related (child) module itself.
    const related = getModuleCap(relation.name);
    const relatedWhere = related ? wholeDays(related, relation.where) : undefined;
    if (relatedWhere) relation = { ...relation, where: relatedWhere };
  }
  return changed ? { ...plan, ...(where ? { where } : {}), ...(relation ? { relation } : {}) } : plan;
}

/** A condition value as a number, when it is one (a number, or numeric text as executor Q's compiler reads it). */
function amountOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : null;
}

/** A Field Service amount is in the caller's own currency (the grammar reads
 * it so too, parse.ts): true when the message writes another currency next
 * to an amount the plan compares one with ("invoices over $5000" for a
 * rupee branch), which can't be compared here; the same for an amount among
 * a has / has_none relation's conditions, on its related module ("customers
 * with invoices over $5000"). The caller's Field Service currency (the
 * cached grammar context) is read only when the message writes a currency
 * next to such an amount; when it can't be read, nothing is refused. */
async function inAnotherCurrency(run: ExecuteRun, view: CapabilityView, cap: ModuleCap, plan: QueryPlan): Promise<boolean> {
  // Each module with the conditions read against it: the plan's own, and a has / has_none relation's.
  const parts: Array<[ModuleCap, readonly Cond[] | undefined]> = [[cap, plan.where]];
  const rel = plan.relation;
  if (rel && rel.kind !== 'for') {
    const related = getModuleCap(rel.name);
    if (related) parts.push([related, rel.where]);
  }
  const written = new Set<string>();
  for (const [module, conds] of parts) {
    for (const cond of conds ?? []) {
      if (!('f' in cond) || !('v' in cond) || !module.fields.some((f) => f.key === cond.f && f.money?.currency === 'fs_branch')) continue;
      const v: unknown = cond.v;
      for (const value of Array.isArray(v) ? v : [v]) {
        const amount = amountOf(value);
        const currency = amount === null ? null : writtenCurrencyFor(run.message, amount);
        if (currency) written.add(currency);
      }
    }
  }
  if (!written.size) return false;
  let fsCurrency: string | null | undefined;
  try {
    ({ fsCurrency } = await beforeDeadline(grammarContextFor(run.identity, run.tenant, view), run.deadline));
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) throw err;
    return false;
  }
  return typeof fsCurrency === 'string' && [...written].some((code) => code !== fsCurrency);
}

/** A planner query (`ground`: tidied by plannerPlan, then its free text and
 * numbers checked against the message, and a follow-up's against the last
 * plan) or a clarify choice's plan, on the grammar's own path. A concept
 * count ("how many customers") is counted per source; any other concept
 * read is its own module's ("list customers": Field Service customers, as
 * the grammar reads it). A module the caller can't use is a notice; a plan
 * that can't run is a clarify; a read that doesn't finish in time is an
 * error notice on either executor. A choice's plan may carry a record's _id
 * (record { ref }, a relation's entity { ref }): this server wrote it; the
 * planner's never runs with one. An agenda plan (Increment 8, spec B9.6) is
 * checked by its own validator and never grounded (its dates and ranges are
 * validated): a window over 3 months is said so, one module's agenda gets
 * the classic assistant, any other problem is not understood. */
async function answerPlan(
  run: ExecuteRun, view: CapabilityView, input: QueryPlan, ground: boolean, path: 'planner' | 'action',
): Promise<Executed> {
  const { identity, tenant, log, deadline } = run;
  const ctx = clarifyContext(run);
  const req = readRequest(
    identity, tenant, view, run.customModules, run.workflows, dailyEventsGate(identity, deadline), run.body.state, run.body.clientContext,
  );
  if (input.op === 'agenda') {
    log.filterKeys = [...filterKeysOf(null, input), ...(input.window ? ['window'] : [])].sort();
    const checked = validateAgendaPlan(input, tenant.timezone);
    if (!checked.ok && checked.tooLong) {
      log.outcome = 'too_long';
      log.view = 'agenda';
      return { composed: composeAgendaTooLong(input), path };
    }
    if (!checked.ok) {
      log.outcome = problemCodes(checked.problems);
      const classic = checked.problems.some((p) => p.code === 'unsupported_target' || p.code === 'unsupported_option');
      return clarified(classic ? composeNeedsClassic(ctx, 'plan') : composeNotUnderstood(ctx));
    }
    const composed = await answerAgenda(checked.plan, req, log, deadline);
    return composed ? { composed, path } : clarified(composeNotUnderstood(ctx));
  }
  let plan = ground ? plannerPlan(input) : input;
  if ('concept' in plan.target) {
    const { concept, sources } = plan.target;
    if (plan.op === 'count' && isConceptKey(concept) && !sources) {
      log.modules = [concept];
      log.filterKeys = plan.mine ? ['mine'] : [];
      if (!runsAsConceptCount(plan)) {
        log.outcome = 'unsupported_option';
        return clarified(composeNeedsClassic(ctx, 'plan'));
      }
      return { composed: await answerConceptCount(concept, plan, identity, tenant, view, log, deadline), path };
    }
    const module = getModuleCap(concept)?.key;
    if (!module || sources || (plan.op !== 'list' && plan.op !== 'count')) {
      log.outcome = 'unsupported_target';
      return clarified(composeNeedsClassic(ctx, 'plan'));
    }
    plan = { ...plan, target: { module } };
  }

  const target = plan.target;
  const customKey = 'module' in target && isCustomModuleKey(target.module) ? target.module : null;
  const cap = 'module' in target && !customKey ? getModuleCap(target.module) ?? null : null;
  log.modules = cap ? [cap.key] : customKey ? [customKey] : [];
  let dropped: GroundingDrop[] = [];
  let fixed: GroundingFix[] = [];
  if (ground) {
    // A record named by its _id: only this server writes one (a choice of
    // records sharing a number, a record card's related list), never the
    // planner (decisions LD4, LD6). Its grounding refuses one too.
    if (plan.record && 'ref' in plan.record) {
      log.filterKeys = filterKeysOf(cap, plan);
      log.outcome = 'record_ref';
      return clarified(composeNeedsClassic(ctx, 'plan'));
    }
    if (cap) plan = withWholeDays(cap, plan);
    // A follow-up ("only the open ones") keeps values of the session's last
    // plan, which this server wrote: they count as found when it read the same module.
    const lastPlan = run.body.state?.lastPlan;
    const module = cap?.key ?? customKey;
    const carried = module && moduleOfPlan(lastPlan) === module ? lastPlan : undefined;
    // A Custom Module's fields are grounded by their kinds (its definition, when it can be read now).
    const grounded = groundPlan(cap ?? (customKey ? await customModuleFor(run, customKey) : null), plan, run.message, carried);
    ({ plan, dropped, fixed } = grounded);
    // Decision WB2: a value the plan can't run without isn't in the message
    // (the record a relation names: run without it, the read would widen),
    // or the plan names a record by its _id: the classic assistant, nothing read.
    if (grounded.refused) {
      log.dropped = dropped.length;
      log.fixed = fixed.length;
      log.filterKeys = filterKeysOf(cap, plan);
      log.outcome = 'not_grounded';
      return clarified(composeNeedsClassic(ctx, 'plan'));
    }
  }
  log.dropped = dropped.length;
  log.fixed = fixed.length;
  log.filterKeys = filterKeysOf(cap, plan);

  if (customKey) {
    const custom = await answerCustom(plan, req, log, deadline);
    if (custom.kind === 'refused') {
      return clarified(notYet(custom.problems, plan, null) ? composeNeedsClassic(ctx, 'plan') : composeNotUnderstood(ctx));
    }
    if (custom.kind === 'none') return clarified(composeNotUnderstood(ctx));
    return { composed: withGroundingNotices(custom.composed, dropped, fixed), path };
  }

  const checked = validateQueryPlan(plan, view);
  if (!checked.ok) {
    const refused = checked.access && checked.module ? getModuleCap(checked.module) : undefined;
    if (refused && checked.access) {
      log.outcome = checked.access;
      return { composed: composeModuleState(refused, checked.access), path };
    }
    log.outcome = problemCodes(checked.problems);
    return clarified(notYet(checked.problems, plan, cap) ? composeNeedsClassic(ctx, 'plan') : composeNotUnderstood(ctx));
  }

  const { cap: readCap, plan: readPlan, executor } = checked;
  if (ground && await inAnotherCurrency(run, view, readCap, readPlan)) {
    log.outcome = 'other_currency';
    return clarified(composeNeedsClassic(ctx, 'plan'));
  }
  log.executor = executor;
  let composed: ComposedAnswer | null;
  try {
    composed = await beforeDeadline(readUnderGates(readCap, readPlan, executor, req, log, deadline), deadline);
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) throw err;
    // Nothing goes to the existing assistant from here: a read that didn't
    // finish, on either executor, is answered in an error state that can be retried.
    logger.warn('CRM assist: read did not finish in time', { module: readCap.key, op: readPlan.op, executor, deadlineMs: RESOLVE_DEADLINE.ms });
    log.outcome = 'deadline';
    composed = composeReadTimedOut(readCap, readPlan);
  }
  // The compiler refused the plan (a stage or outcome the tenant doesn't
  // have, a date that doesn't exist, ...): the plan was wrong.
  if (!composed) return clarified(composeNotUnderstood(ctx));
  // A question back (which record the name means, which one "this" is) is a clarify answer.
  return { composed: withGroundingNotices(composed, dropped, fixed), path: isClarify(composed) ? 'clarify' : path };
}

/** The guided form's caller in an execute call: the body's chat session (workflowsGate checks it is the caller's own). */
function callerOf(run: ExecuteRun): WorkflowCaller {
  return { identity: run.identity, tenant: run.tenant, sessionId: run.body.sessionId, url: run.url };
}

/** The grammar context a planner fill is grounded with: the caller's modules
 * and the form's own (its stage words), the tenant's today, clock and zone. */
function fillGrammarFor(run: ExecuteRun, module: string): Promise<GrammarContext> {
  const own = getModuleCap(module);
  const modules = run.view?.modules ?? [];
  return grammarContextFor(run.identity, run.tenant, { modules: own && !modules.some((m) => m.key === own.key) ? [...modules, own] : modules });
}

/** Values typed for a form (spec B12.9): they belong to the session's own
 * open draft (bindFill: the form the browser names, else the session
 * state's; the caller's own, in this chat and branch, still a draft). They
 * are grounded in the message (planner-grounding.ts groundFill: what it
 * doesn't say is left out, and said so; dates are read again from it), then
 * applied as a typed answer (applyFill, origin suggested). While its review
 * card is open nothing changes (L1: Press Edit there), nor while workflows
 * are off. No open form: the clarify that says so. */
async function answerFill(run: ExecuteRun, output: Extract<PlannerOutput, { kind: 'fill' }>): Promise<Executed> {
  const { body, log } = run;
  let bound: FillBinding;
  try {
    bound = await beforeDeadline(bindFill(run.identity, body.sessionId, body.clientContext?.operationId ?? body.state?.operationId), run.deadline);
  } catch (err) {
    if (!(err instanceof DeadlineExceededError)) throw err;
    log.outcome = 'deadline';
    return { composed: composeNotInTime(), path: 'planner' };
  }
  const reviewOpen = !bound.ok && bound.reason === 'not_draft' && bound.status === 'staged';
  if (!bound.ok && !reviewOpen) {
    log.outcome = bound.reason;
    return clarified(composeNoFocus());
  }
  if (bound.module) log.modules = [bound.module];
  if (!(await run.workflows())) {
    log.outcome = 'workflows_off';
    return formNotice('workflows_off', WORKFLOWS_OFF_MESSAGE, 'warning');
  }
  if (!bound.ok) {
    log.outcome = 'review_pending';
    return formNotice('review_pending', REVIEW_PENDING_MESSAGE);
  }
  const { operationId } = bound;
  const caller = callerOf(run);
  let dropped: GroundingDrop[] = [];
  const answered = await workflowAnswer('fill', async () => {
    const spec = await formSpecFor(operationId, caller);
    // Closed meanwhile: its card as it is now.
    if (!spec) return workflowStatus(operationId, caller);
    const grounded = groundFill({
      values: output.values, refs: output.refs ?? {}, message: run.message, spec, ctx: await fillGrammarFor(run, spec.module),
    });
    dropped = grounded.dropped;
    return applyFill(operationId, {
      values: grounded.values, refs: grounded.refs, source: 'planner', fieldNotes: grounded.fieldNotes,
    }, caller);
  }, run.deadline, log);
  log.dropped = dropped.length;
  if (!answered) return clarified(composeNoFocus());
  return { composed: withGroundingNotices(answered.composed, dropped), path: answered.path };
}

/** Input start (spec B1): a clarify choice's or a record card's write
 * intent, written by this server, as its guided form or delete review, with
 * no AI call and no grounding: startWorkflow checks it all again as the
 * caller (the module's switch, the permission, the record under scope).
 * While workflows are off, a notice that says so; a module with no guided
 * form for the operation, the classic assistant's clarify. */
async function answerStart(run: ExecuteRun, intent: WriteIntent): Promise<Executed> {
  const { log } = run;
  log.modules = getModuleCap(intent.module) ? [intent.module] : [];
  if (!(await run.workflows())) {
    log.outcome = 'workflows_off';
    return formNotice('workflows_off', WORKFLOWS_OFF_MESSAGE, 'warning');
  }
  const caller = callerOf(run);
  const answered = await workflowAnswer('start', () => startWorkflow({
    intent, source: 'action', focus: focusOf(run.body.state, run.body.clientContext), deadline: run.deadline,
  }, caller), run.deadline, log, caller);
  if (answered) return answered;
  log.outcome = 'needs_classic';
  return clarified(composeNeedsClassic(clarifyContext(run), 'write'));
}

/** A planner's write intent (spec B1): for one of the 22 modules with a
 * guided form while workflows are effective, it is grounded in the message
 * first (planner-grounding.ts groundWriteIntent: what the message doesn't
 * say is left out, and said so; dates and stages are read again from it; a
 * record the planner names by an _id refuses it, and a work order an
 * invoice is made from is kept only by a number the message writes), then
 * opens the form as typed wording does. Any other write intent, or one that
 * can't be grounded, gets "Use the classic assistant" as before. */
async function answerWrite(run: ExecuteRun, intent: WriteIntent): Promise<Executed> {
  const { log } = run;
  const ctx = clarifyContext(run);
  const cap = getModuleCap(intent.module);
  log.modules = cap ? [cap.key] : [];
  const wf = WORKFLOW_MODULE_KEYS.has(intent.module) ? workflowModuleFor(intent.module) : undefined;
  if (!wf || !(await run.workflows())) {
    log.outcome = 'needs_classic';
    return clarified(composeNeedsClassic(ctx, 'write'));
  }
  // Without the grammar context (late or unreadable) the planner's dates and
  // stage values are dropped and listed as not taken, never guessed.
  let grammar: GrammarContext | undefined;
  try {
    grammar = await beforeDeadline(fillGrammarFor(run, intent.module), run.deadline);
  } catch {
    grammar = undefined;
  }
  const grounded = groundWriteIntent({ intent, message: run.message, wf, ...(grammar ? { ctx: grammar } : {}) });
  log.dropped = grounded.dropped.length;
  if (grounded.refused) {
    log.outcome = 'not_grounded';
    return clarified(composeNeedsClassic(ctx, 'write'));
  }
  const caller = callerOf(run);
  const answered = await workflowAnswer('start', () => startWorkflow({
    intent: grounded.intent, source: 'planner', fieldNotes: grounded.fieldNotes,
    focus: focusOf(run.body.state, run.body.clientContext), deadline: run.deadline,
  }, caller), run.deadline, log, caller);
  if (!answered) {
    log.outcome = 'needs_classic';
    return clarified(composeNeedsClassic(ctx, 'write'));
  }
  return { composed: withGroundingNotices(answered.composed, grounded.dropped), path: answered.path };
}

/** One of the caller's Custom Modules, for grounding a planner plan about it;
 * null when the caller can't use it or it can't be read in time (answerCustom
 * then says why, from the same read). */
async function customModuleFor(run: ExecuteRun, key: string): Promise<CustomModuleInfo | null> {
  try {
    const read = await beforeDeadline(run.customModules(), run.deadline);
    return read.access === 'ok' ? read.modules.find((m) => m.key === key) ?? null : null;
  } catch {
    return null;
  }
}

/** A plan to read, but the caller's modules weren't read in time (or the read failed): nothing runs. */
function notReadInTime(run: ExecuteRun, path: AnswerPath): Executed {
  run.log.outcome = run.viewFailed ? 'view_failed' : 'deadline';
  return { composed: composeNotInTime(), path };
}

async function dispatchExecute(run: ExecuteRun): Promise<Executed> {
  const { input } = run.body;
  const { log } = run;
  const ctx = clarifyContext(run);
  if (input.kind === 'fallback') {
    log.outcome = input.reason;
    return clarified(fallbackClarify(input.reason, ctx, input.wait));
  }
  if (input.kind === 'run_plan') return run.view ? answerPlan(run, run.view, input.plan, false, 'action') : notReadInTime(run, 'action');
  if (input.kind === 'start') return answerStart(run, input.intent);

  // The output first: only a query needs the caller's modules; the other
  // kinds are answered without them (with no plan examples).
  const output = readPlannerOutput(input.output);
  if (!output) {
    log.plannerKind = 'invalid';
    log.outcome = 'invalid_output';
    return clarified(composeNotUnderstood(ctx));
  }
  log.plannerKind = output.kind;
  switch (output.kind) {
    case 'query':
      return run.view ? answerPlan(run, run.view, output.plan, true, 'planner') : notReadInTime(run, 'planner');
    case 'write':
      return answerWrite(run, output.intent);
    case 'fill':
      return answerFill(run, output);
    case 'clarify':
      log.outcome = 'missing_value';
      // Each option goes back with the question as first asked: the planner never sees the conversation.
      return clarified(composePlannerClarify(output.question, output.options, run.message));
    case 'out_of_scope':
      log.outcome = 'out_of_scope';
      return clarified(composeOutOfScope(ctx));
  }
}

async function execute(
  body: ExecuteRequest, identity: AssistIdentity, tenant: GatewayTenant, log: ExecuteLog, deadline: number, url: string,
): Promise<ExecuteResult> {
  const run: ExecuteRun = {
    identity, tenant, view: null, body, message: body.message ?? '', log, deadline, customModules: customModulesOnce(identity, tenant),
    url, workflows: workflowsGate(identity, body.sessionId, deadline),
  };
  try {
    run.view = await beforeDeadline(getCapabilityView(identity.tenantId, identity, tenant), deadline);
  } catch (err) {
    // Answered without them (dispatchExecute): only a plan to read needs
    // them, and a failed read is no reason for an error reply.
    if (err instanceof DeadlineExceededError) {
      logger.warn('CRM assist: the capability view was not ready in time', { deadlineMs: RESOLVE_DEADLINE.ms });
    } else {
      run.viewFailed = true;
      logger.warn('CRM assist: the capability view could not be read', { error: (err as Error)?.message });
    }
  }
  const { composed, path } = await dispatchExecute(run);
  log.path = path;
  return finalizeAnswer(composed, body.state, path);
}

router.post('/:tenantId/execute', markStart, identityStep, tenantStep, crmAssistInternalRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    const { crmAssistIdentity: identity, crmAssistTenant: tenant, crmAssistStartedAt } = res.locals as Locals;
    const started = crmAssistStartedAt ?? Date.now();
    try {
      const body = ExecuteRequestSchema.safeParse(req.body);
      if (!body.success) { sendInvalidBody(res, 'execute', body.error.issues[0]); return; }
      const { input } = body.data;
      if (input.kind !== 'run_plan' && input.kind !== 'start' && !body.data.message) {
        sendError(res, `Invalid execute request: message is required with input "${input.kind}"`, 400);
        return;
      }
      if (rejectIfBotDisabled(res, identity!, tenant!)) return;
      const log: ExecuteLog = { path: 'clarify', modules: [], filterKeys: [], dropped: 0, fixed: 0 };
      const result = await execute(body.data, identity!, tenant!, log, started + RESOLVE_DEADLINE.ms, req.originalUrl);
      logger.info('CRM assist execute', {
        tenantId: identity!.tenantId, userId: identity!.userId, input: input.kind, plannerKind: log.plannerKind,
        path: log.path, modules: log.modules, filterKeys: log.filterKeys, dropped: log.dropped, fixed: log.fixed,
        executor: log.executor, rows: log.rows, total: log.total, outcome: log.outcome, view: log.view, dailyEvents: log.dailyEvents,
        durationMs: Date.now() - started,
      });
      sendSuccess(res, result, 'OK');
    } catch (err) {
      next(err);
    }
  });

/* ── Operations (Increment 2) ───────────────────────────────────────────
 * The existing assistant's proposals are staged here and confirmed once
 * (operations/operation.service.ts):
 *   POST /:tenantId/operations              -> 200 StageOperationResult (a refusal is ok:false with a code)
 *   POST /:tenantId/operations/:id/confirm  -> 200 OperationOutcome, or 409 when the revision or payloadHash
 *                                              is not the staged one (the operation stays staged; the body's
 *                                              data is a 'pending' OperationOutcome with the same message)
 *   POST /:tenantId/operations/:id/cancel   -> 200 OperationOutcome
 *   POST /:tenantId/operations/:id/status   -> 200 OperationOutcome
 * Same gates, in the same order, as resolve: identity (401), tenant active
 * (403), per-user limit (429), the operation id and body (400), bot_enabled
 * (403). One log line per call: ids, module, op, field keys and the outcome,
 * never a value. */

function sendInvalidBody(res: Response, what: string, issue: ZodIssue | undefined): void {
  sendError(res, `Invalid ${what} request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? 'is invalid'}`.trim(), 400);
}

function rejectIfBotDisabled(res: Response, identity: AssistIdentity, tenant: GatewayTenant): boolean {
  if (!isModuleFlagDisabled(tenant.flags, 'bot_enabled', identity.role)) return false;
  sendError(res, moduleDisabledMessage('The CRM assistant'), 403);
  return true;
}

router.post('/:tenantId/operations', identityStep, tenantStep, crmAssistInternalRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const { crmAssistIdentity: identity, crmAssistTenant: tenant } = res.locals as Locals;
    try {
      const body = StageOperationRequestSchema.safeParse(req.body);
      if (!body.success) { sendInvalidBody(res, 'stage', body.error.issues[0]); return; }
      if (rejectIfBotDisabled(res, identity!, tenant!)) return;
      const result = await stageOperation(body.data, { identity: identity!, tenant: tenant!, url: req.originalUrl });
      logger.info('CRM assist operation stage', {
        tenantId: identity!.tenantId, userId: identity!.userId, module: body.data.module, op: body.data.op,
        ok: result.ok, ...(result.ok
          ? { operationId: result.operationId, fieldKeys: result.review.changes.map((c) => c.key) }
          : { code: result.code, fieldKeys: Object.keys(result.fieldErrors ?? {}) }),
        durationMs: Date.now() - started,
      });
      sendSuccess(res, result, 'OK');
    } catch (err) {
      next(err);
    }
  });

type OperationAction<B> = (operationId: string, body: B, caller: OperationCaller) => Promise<OperationReply>;

function operationRoute<B>(step: 'confirm' | 'cancel' | 'status', schema: ZodType<B>, action: OperationAction<B>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const started = Date.now();
    const { crmAssistIdentity: identity, crmAssistTenant: tenant } = res.locals as Locals;
    try {
      const operationId = req.params.id;
      if (!OPERATION_ID_RE.test(operationId)) { sendError(res, 'Invalid operation id', 400); return; }
      const body = schema.safeParse(req.body);
      if (!body.success) { sendInvalidBody(res, step, body.error.issues[0]); return; }
      if (rejectIfBotDisabled(res, identity!, tenant!)) return;
      const reply = await action(operationId, body.data, { identity: identity!, tenant: tenant!, url: req.originalUrl });
      logger.info(`CRM assist operation ${step}`, {
        tenantId: identity!.tenantId, userId: identity!.userId, operationId, http: reply.http,
        status: reply.http === 200 ? reply.outcome.status : 'refused',
        ...(reply.http === 200 && reply.outcome.repeat ? { repeat: true } : {}),
        durationMs: Date.now() - started,
      });
      if (reply.http === 409) {
        // Nothing ran and the operation stays staged: the body still carries
        // a 'pending' outcome, so the AI service shows this message and the
        // card offers Confirm again instead of reporting an unknown result.
        const outcome: OperationOutcome = { operationId, status: 'pending', message: reply.message };
        res.status(409).json({ success: false, message: reply.message, data: outcome });
        return;
      }
      sendSuccess(res, reply.outcome, 'OK');
    } catch (err) {
      next(err);
    }
  };
}

router.post('/:tenantId/operations/:id/confirm', identityStep, tenantStep, crmAssistInternalRateLimit,
  operationRoute('confirm', ConfirmOperationRequestSchema, confirmOperation));
router.post('/:tenantId/operations/:id/cancel', identityStep, tenantStep, crmAssistInternalRateLimit,
  operationRoute('cancel', SessionOnlyRequestSchema, cancelOperation));
router.post('/:tenantId/operations/:id/status', identityStep, tenantStep, crmAssistInternalRateLimit,
  operationRoute('status', SessionOnlyRequestSchema, operationStatus));

export default router;
