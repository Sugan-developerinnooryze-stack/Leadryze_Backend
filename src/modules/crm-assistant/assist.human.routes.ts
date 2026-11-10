import { Router, Response, NextFunction } from 'express';
import type { ZodIssue, ZodType } from 'zod';
import { AuthRequest } from '../../types';
import { engineModeFor } from '../../config';
import { requirePermission } from '../../middlewares/auth.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { crmAssistActionRateLimit, crmAssistFormRateLimit } from '../../middlewares/rate-limit.middleware';
import { requireCrmAssistantFeature } from '../ai/crm-assistant-settings.service';
import { namespacedSessionId } from '../ai/crm-chat.service';
import { sendError, sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import type { QueryPlan } from './contracts/plan';
import { OPERATION_ID_RE } from './contracts/api';
import { isKnownAppLink } from './contracts/routes';
import {
  DataTableBlock, FORM_CAPS, FormActionResult, FormActionResultSchema, FormRevisionRequestSchema, FormSessionRequestSchema,
  FormValidateRequestSchema, LookupRequestSchema, LookupResult, LookupResultSchema, NoticeBlock, VIEWS_VERSION, ViewActionRequest,
  ViewActionRequestSchema, ViewActionResult, ViewActionResultSchema, collectLinks, validateViews,
} from './contracts/views';
import { AssistIdentity } from './identity';
import {
  GatewayTenant, TENANT_INACTIVE_MESSAGE, gateModuleRead, isTenantBlocked, loadGatewayTenant, meetsRoleIdRule,
} from './gates';
import { getCapabilityView } from './capability-view';
import { getModuleCap } from './registry';
import type { ModuleCap } from './registry/types';
import { isQuerySortable, queryCapsFor } from './registry/query-caps';
import { customModuleAccess, findCustomModule, isCustomModuleKey } from './registry/custom-modules';
import type { CustomModuleInfo } from './registry/custom-modules';
import { SOURCE_LABELS } from './registry/labels';
import { chooseExecutor, validateQueryPlan } from './query/validate';
import { ExecContext, executeList, moduleDefFor } from './query/execute-list';
import { PlanRejectedError, executeQueryList, fsAmountsRankable } from './query/execute-query';
import { MineUnavailableError } from './query/mine';
import { ScopeFailClosedError } from './query/scoped-match';
import { gateRelated, prepareRelation } from './query/relations';
import { applyCustomViewAction, executeCustomList, validateCustomPlan } from './query/execute-custom';
import { ComposeEnv, composeMineUnavailableTable, composeTable, fsRankableOnL } from './views/compose';
import { composeCustomTable } from './views/compose-custom';
import { RelationWords, relationWords } from './views/chips';
import { scrubIds } from './views/fallback-text';
import { WORKFLOWS_OFF_MESSAGE } from './operations/operation.service';
import { cancelWorkflow, editStaged, reviewDraft, validateDraft, workflowStatus } from './operations/workflow.service';
import { lookupForDraft } from './operations/lookup';
import type { WorkflowCaller, WorkflowReply } from './writes/workflow-types';

/* The CRM assistant's browser routes, mounted by crm-chat.routes.ts under
 * /api/v1/ai/crm-assist after its router-level authenticate, requireTenant
 * and resolveBranch.
 *
 * POST /view — sort a table, page it or drop one of its filter chips. The
 * browser sends back the table's own handle {plan, section, executor} with
 * { page?, sort?, removeFilter? }; nothing here calls the AI service or a
 * model. Gates, in order: bot.use, bot_enabled, the visualAnswers switch,
 * 60 actions a minute per user, the body (400), the tenant still active
 * (403). The handle carries no identity: the plan is re-validated for the
 * current caller (capability view) and re-run under their own gates, scope
 * and branch (gateModuleRead, which computes the scope itself — so
 * resolveDataScopeMiddleware is deliberately not mounted: the scope would
 * be read twice), on the handle's own executor, except a sort: every sort
 * runs on executor Q, whose _id tie-break pages stably (list() sorts have
 * no unique tie-breaker, so their pages could repeat or skip rows). An L
 * table without a text search reads the same records on Q (its scope
 * closures mirror list(): tests/crm-assist-scope-parity.test.ts) and comes
 * back with a Q handle; so does an L handle that already carries a sort
 * (made before every sort ran on Q) and otherwise only what list() runs,
 * whatever the request. A searched L table is never re-run on Q: list() and
 * executor Q search differently.
 *
 *   sort         the key must be one executor Q can sort by, else 400; on an
 *                L table with a text search the table comes back unchanged
 *                with the notice sort_unavailable_with_search
 *   removeFilter "w<i>" drops plan.where[i], "search" drops plan.search,
 *                "mine" drops plan.mine (on the handle's executor, Q), "rel"
 *                drops plan.relation (Q); "cur" (the currency the engine
 *                adds) or anything else: 400
 *   page         1..1000
 * Concept, connector and detail handles can't be re-run here (400). A
 * "mine" table whose "mine" can't be answered any more (the caller's staff
 * profile is gone, say) comes back in the 'unsupported' state with the
 * reason and no rows, its "mine" chip still removable; never a 500.
 *
 * Increment 5: a table with a relation ("customers with invoices", "work
 * orders for ABC Industries", the record kept by its _id) works the relation
 * out again, under the other module's own gates and scope, every time
 * (query/relations.ts prepareRelation): the other module refused now is a
 * 403 with its reason, the record no longer visible or too many keys a 400.
 * A Custom Module's table (executor M, "custom:<slug>") re-runs on executor M
 * after the Custom Module gates (403 when switched off or not allowed): its
 * page, a sort by one of its sortable fields, or one of its chips removed
 * (query/execute-custom.ts applyCustomViewAction); a module deleted since,
 * or a key the app can't make, is a 400.
 * 200: { block: DataTableBlock, notices: NoticeBlock[] }, validated like
 * every chat block. One log line per call: keys and ids only, never a
 * search text or a condition value.
 *
 * Increment 6 adds the guided forms' routes: a form's validate, review,
 * edit, cancel and status steps and its record picker's lookup (below,
 * "Guided forms"). */

const router = Router();

type ViewReply =
  | { http: 200; result: ViewActionResult; rows: number; total: number | null; executor: 'L' | 'Q' | 'M'; outcome?: string }
  | { http: 400 | 403 | 500 | 503; message: string; code: string };

const NOT_RERUNNABLE = "This table can't be changed here. Ask the assistant again instead.";
const CANT_CHANGE = "This table can't be changed that way.";

function refuse(http: 400 | 403 | 500 | 503, code: string, message: string): ViewReply {
  return { http, code, message };
}

function plural(cap: ModuleCap): string {
  return cap.labels.plural;
}

/** "Sorting isn't available while searching Leads by text; clear the search to sort." */
function sortUnavailableNotice(cap: ModuleCap): NoticeBlock {
  return {
    id: 'v-sort',
    type: 'notice',
    tone: 'info',
    code: 'sort_unavailable_with_search',
    text: `Sorting isn't available while searching ${plural(cap)} by text; clear the search to sort.`,
  };
}

function withoutPage(plan: QueryPlan): QueryPlan {
  const { page: _page, ...rest } = plan;
  return rest;
}

/** The handle's plan with the request applied, and the executor it runs on
 * (a sort, or an L handle whose own sort is all list() can't run: Q; a page
 * or a removed chip: the handle's own), or why it can't be. */
function applyAction(
  cap: ModuleCap, input: ViewActionRequest, notices: NoticeBlock[],
): { ok: true; plan: QueryPlan; executor: 'L' | 'Q' } | { ok: false; reply: ViewReply } {
  const { handle } = input;
  let plan: QueryPlan = { ...handle.plan };
  let executor: 'L' | 'Q' = handle.executor === 'Q' ? 'Q' : 'L';
  let reset = false;

  if (input.removeFilter !== undefined) {
    const id = input.removeFilter;
    // Chip ids are exactly "w0", "w1", ... (views/chips.ts); "w01" is not one.
    const where = /^w(0|[1-9]\d{0,2})$/.exec(id);
    const index = where ? Number(where[1]) : -1;
    if (where && plan.where && index < plan.where.length) {
      const rest = plan.where.filter((_, i) => i !== index);
      const { where: _where, ...others } = plan;
      plan = rest.length ? { ...others, where: rest } : others;
    } else if (id === 'search' && plan.search !== undefined) {
      const { search: _search, ...others } = plan;
      plan = others;
    } else if (id === 'mine' && plan.mine !== undefined) {
      // The same records without "assigned to you" (or "created by you"), on the same executor.
      const { mine: _mine, ...others } = plan;
      plan = others;
    } else if (id === 'rel' && plan.relation !== undefined) {
      // The same records without "with invoices" (or "for ABC Industries"), on the same executor.
      const { relation: _relation, ...others } = plan;
      plan = others;
    } else {
      // "cur" (the currency next to an amount) is the engine's own and can't be removed.
      return { ok: false, reply: refuse(400, 'filter_not_removable', "That filter can't be removed from this table.") };
    }
    reset = true;
  }

  if (input.sort !== undefined) {
    if (executor === 'L' && plan.search?.trim()) {
      // list() and executor Q search differently, so a searched L table is
      // never re-run on Q, and list() can't sort it: no sort here.
      notices.push(sortUnavailableNotice(cap));
    } else {
      const field = cap.fields.find((f) => f.key === input.sort!.key);
      // What executor Q can sort by, on either kind of table (sortableOn).
      if (!field || !queryCapsFor(cap.key)?.q || !isQuerySortable(cap, field)) {
        return { ok: false, reply: refuse(400, 'not_sortable', "This table can't be sorted by that column.") };
      }
      plan = { ...plan, sort: { by: field.key, dir: input.sort.dir } };
      // Every sort runs on Q: its _id tie-break pages stably. Without a text
      // search an L table's records are the same on Q (the same scope).
      executor = 'Q';
      reset = true;
    }
  }

  // An L handle from before every sort ran on Q can still carry its sort,
  // which list() no longer runs. When that sort is all that keeps it off
  // list() (no text search, no conditions), it re-runs on Q with that sort and
  // comes back as a Q handle, as a sort request would (validateQueryPlan still
  // refuses a sort Q can't run); any other L handle stays on L.
  if (executor === 'L' && plan.sort && !plan.search?.trim()) {
    const { sort: _sort, ...unsorted } = plan;
    if (chooseExecutor(unsorted, cap) === 'L') executor = 'Q';
  }

  if (input.page !== undefined) plan = { ...plan, page: input.page };
  else if (reset) plan = withoutPage(plan);
  return { ok: true, plan, executor };
}

/** The re-run table and its notices, checked as every chat block is (schema,
 * caps, app links), fail closed. */
function validatedReply(
  table: DataTableBlock, notices: NoticeBlock[], module: string, executor: 'L' | 'Q' | 'M', outcome?: string,
): ViewReply {
  const allNotices = notices.slice(0, 3).map((n) => ({ ...n, text: scrubIds(n.text) }));
  const { views, dropped } = validateViews({ v: VIEWS_VERSION, turnId: 'view-action', blocks: [table, ...allNotices] });
  const result = views && dropped.length === 0
    ? ViewActionResultSchema.safeParse({ block: views.blocks[0], notices: views.blocks.slice(1) })
    : null;
  if (!result || !result.success) {
    logger.warn('CRM assist view: the re-run table failed validation', { module, dropped });
    return refuse(500, 'invalid_table', "This table couldn't be shown. Ask the assistant again.");
  }
  return { http: 200, result: result.data, rows: table.rows.length, total: table.page.total, executor, ...(outcome ? { outcome } : {}) };
}

/** A Custom Module's table (executor M): the Custom Module gates (the
 * config_customModules flag, then records.view and definitions.view), the
 * module as the tenant defines it now, the change, the plan checked against
 * that definition, then the read on executor M. */
async function runCustomViewAction(input: ViewActionRequest, identity: AssistIdentity, tenant: GatewayTenant): Promise<ViewReply> {
  const { handle } = input;
  const module = 'module' in handle.plan.target ? handle.plan.target.module : '';
  // "custom:<slug>" with a slug the app makes (lower-case letters, digits, hyphens), a list only.
  if (!isCustomModuleKey(module) || handle.plan.op !== 'list') return refuse(400, 'not_rerunnable', NOT_RERUNNABLE);
  const label = SOURCE_LABELS.custom_module;
  const access = await customModuleAccess(identity.tenantId, identity, tenant);
  if (access === 'tenant_inactive') return refuse(403, 'tenant_inactive', TENANT_INACTIVE_MESSAGE);
  if (access !== 'ok') return refuse(403, access, access === 'disabled' ? `${label} are turned off for your company.` : `You don't have access to ${label}.`);
  let info: CustomModuleInfo | undefined;
  try {
    info = await findCustomModule(identity.tenantId, module);
  } catch (err) {
    logger.warn('CRM assist view: Custom Modules could not be read', { error: (err as Error)?.message });
    return refuse(503, 'query_failed', `Couldn't read ${label} right now. Try again in a moment.`);
  }
  if (!info) return refuse(400, 'not_rerunnable', "That Custom Module wasn't found. It may have been deleted; ask the assistant again.");
  const applied = applyCustomViewAction(info, handle.plan, {
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.removeFilter !== undefined ? { removeFilter: input.removeFilter } : {}),
  });
  if (!applied.ok) return refuse(400, applied.code, applied.message);
  const checked = validateCustomPlan(applied.plan, info);
  if (!checked.ok) return refuse(400, checked.problems[0]?.code ?? 'invalid_plan', CANT_CHANGE);
  let composed: ReturnType<typeof composeCustomTable>;
  try {
    const result = await executeCustomList(info, checked.plan, { tenantId: identity.tenantId, timezone: tenant.timezone });
    composed = composeCustomTable(info, checked.plan, result, { timezone: tenant.timezone });
  } catch (err) {
    if (err instanceof PlanRejectedError) return refuse(400, 'plan_rejected', CANT_CHANGE);
    logger.warn('CRM assist view: read failed', { module: 'custom', executor: 'M', error: (err as Error)?.message });
    return refuse(503, 'query_failed', `Couldn't read ${info.name} right now. Try again in a moment.`);
  }
  return validatedReply(composed.table, composed.notices, 'custom', 'M');
}

async function runViewAction(input: ViewActionRequest, identity: AssistIdentity, tenant: GatewayTenant): Promise<ViewReply> {
  const { handle } = input;
  if (handle.executor === 'M') return runCustomViewAction(input, identity, tenant);
  // Only a table of one module, re-run on executor L or Q, can change here.
  if (handle.executor !== 'L' && handle.executor !== 'Q') return refuse(400, 'not_rerunnable', NOT_RERUNNABLE);
  if (!('module' in handle.plan.target) || handle.plan.op !== 'list' || handle.plan.record !== undefined) {
    return refuse(400, 'not_rerunnable', NOT_RERUNNABLE);
  }
  const cap = getModuleCap(handle.plan.target.module);
  if (!cap) return refuse(400, 'unknown_module', NOT_RERUNNABLE);

  const notices: NoticeBlock[] = [];
  const applied = applyAction(cap, input, notices);
  if (!applied.ok) return applied.reply;
  const { executor } = applied;

  const view = await getCapabilityView(identity.tenantId, identity, tenant);
  const checked = validateQueryPlan(applied.plan, view, { executor });
  if (!checked.ok) {
    if (checked.access === 'disabled') return refuse(403, 'disabled', `${plural(cap)} are turned off for your company.`);
    if (checked.access === 'no_permission') return refuse(403, 'no_permission', `You don't have access to ${plural(cap)}.`);
    return refuse(400, checked.problems[0]?.code ?? 'invalid_plan', CANT_CHANGE);
  }
  // Never another executor than the one chosen above (validateQueryPlan was told which).
  if (checked.executor !== executor) return refuse(400, 'executor_mismatch', CANT_CHANGE);

  const gate = await gateModuleRead(identity.tenantId, tenant, identity, {
    flagKey: cap.gate.flagKey, label: moduleDefFor(cap).label, viewPermission: `${cap.gate.permPrefix}.view`, scopeKey: cap.gate.scopeKey,
  });
  if (!gate.ok) {
    if (gate.reason === 'tenant_inactive') return refuse(403, 'tenant_inactive', TENANT_INACTIVE_MESSAGE);
    return refuse(403, gate.reason, gate.reason === 'disabled'
      ? `${plural(cap)} are turned off for your company.`
      : `You don't have access to ${plural(cap)}.`);
  }

  const ctx: ExecContext = {
    tenantId: identity.tenantId,
    identity: { userId: identity.userId, role: identity.role, ...(identity.roleId ? { roleId: identity.roleId } : {}) },
    branchId: gate.branchId,
    scope: gate.scope,
    timezone: tenant.timezone,
  };
  const env: ComposeEnv = { timezone: tenant.timezone, scopeKind: gate.scope.kind, canViewModule: (m) => view.has(m) };
  let plan = checked.plan;
  let composed: ReturnType<typeof composeTable>;
  let outcome: string | undefined;
  let relation: RelationWords | undefined;
  try {
    if (executor === 'Q') {
      // The relation again, under the other module's own gates and scope now (the handle keeps a found record by its _id).
      const rel = await prepareRelation(checked.cap, plan, gateRelated({ identity, tenant }), null);
      if (rel.kind === 'related_unavailable') {
        if (rel.reason === 'tenant_inactive') return refuse(403, 'tenant_inactive', TENANT_INACTIVE_MESSAGE);
        return refuse(rel.reason === 'unknown_module' ? 400 : 403, rel.reason, rel.notice.text);
      }
      if (rel.kind === 'entity_not_found' || rel.kind === 'too_many_keys') return refuse(400, rel.kind, rel.notice.text);
      if (rel.kind !== 'ready') return refuse(400, 'not_rerunnable', NOT_RERUNNABLE);
      plan = rel.plan;
      relation = relationWords(checked.cap, rel) ?? undefined;
      const result = await executeQueryList(checked.cap, plan, ctx, rel.relation ? rel.extras : undefined);
      composed = composeTable(checked.cap, plan, result, env, {
        executor: 'Q', sort: result.sort, implied: result.implied, notices: result.notices, fsRankable: result.fsRankable,
        ...(relation ? { relation } : {}),
      }, { prefix: 'v-n', first: 1 });
    } else {
      // Whether its Field Service amounts can be sorted, read alongside list() when it
      // matters, within its own short budget: past it, or on a failure, that column is
      // just not offered for sorting (fsRankableOnL); the table never waits longer.
      const [result, fsRankable] = await Promise.all([
        executeList(checked.cap, plan, ctx),
        fsRankableOnL(checked.cap, plan, () => fsAmountsRankable(checked.cap, ctx)),
      ]);
      composed = composeTable(checked.cap, plan, result, env, { executor: 'L', fsRankable }, { prefix: 'v-n', first: 1 });
    }
  } catch (err) {
    if (err instanceof PlanRejectedError) return refuse(400, 'plan_rejected', CANT_CHANGE);
    if (!(err instanceof MineUnavailableError)) {
      logger.warn('CRM assist view: read failed', {
        module: cap.key, executor, scopeFailedClosed: err instanceof ScopeFailClosedError, error: (err as Error)?.message,
      });
      return refuse(503, 'query_failed', `Couldn't read ${plural(cap)} right now. Try again in a moment.`);
    }
    // "Mine" can't be answered for this caller now: the table says why, with
    // no rows, and keeps its handle so the "mine" chip can be removed.
    composed = composeMineUnavailableTable(checked.cap, plan, err, env, executor, relation);
    outcome = err.code;
  }

  // The same checks as every chat block (schema, caps, app links), fail closed.
  return validatedReply(composed.table, [...notices, ...composed.notices], cap.key, executor, outcome);
}

router.post('/view',
  requirePermission('bot.use'),
  requireModuleEnabled('bot_enabled'),
  requireCrmAssistantFeature('visualAnswers'),
  crmAssistActionRateLimit,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const started = Date.now();
    try {
      const body = ViewActionRequestSchema.safeParse(req.body);
      if (!body.success) {
        const issue = body.error.issues[0];
        sendError(res, `Invalid view request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? 'is invalid'}`.trim(), 400);
        return;
      }
      // Identity from the verified login only (the same fields the chat's internalAuth token is minted from).
      const identity: AssistIdentity = {
        tenantId: req.tenantId!,
        userId: req.user!.userId,
        role: req.user!.role,
        ...(req.user!.roleId ? { roleId: req.user!.roleId } : {}),
        branchId: req.branchId ?? null,
      };
      if (!meetsRoleIdRule(identity)) { sendError(res, 'Insufficient permissions', 403); return; }
      const tenant = await loadGatewayTenant(identity.tenantId);
      if (isTenantBlocked(tenant, identity)) { sendError(res, TENANT_INACTIVE_MESSAGE, 403); return; }

      const reply = await runViewAction(body.data, identity, tenant);
      const { handle } = body.data;
      logger.info('CRM assist view action', {
        tenantId: identity.tenantId, userId: identity.userId,
        module: 'module' in handle.plan.target ? handle.plan.target.module : 'concept',
        executor: handle.executor,
        ...(reply.http === 200 && reply.executor !== handle.executor ? { ranOn: reply.executor } : {}),
        action: {
          ...(body.data.page !== undefined ? { page: body.data.page } : {}),
          ...(body.data.sort ? { sort: body.data.sort.key, dir: body.data.sort.dir } : {}),
          ...(body.data.removeFilter ? { removeFilter: body.data.removeFilter } : {}),
        },
        http: reply.http,
        ...(reply.http === 200
          ? { rows: reply.rows, total: reply.total, notices: reply.result.notices.map((n) => n.code), ...(reply.outcome ? { outcome: reply.outcome } : {}) }
          : { code: reply.code }),
        durationMs: Date.now() - started, llmCalls: 0,
      });
      if (reply.http !== 200) { sendError(res, reply.message, reply.http); return; }
      sendSuccess(res, reply.result, 'OK');
    } catch (err) {
      next(err);
    }
  });

/* ── Guided forms (Increment 6, spec B6) ──────────────────────────────────
 * A guided form's steps from the browser, all POST, with no AI service hop
 * and no model call (operations/workflow.service.ts and operations/lookup.ts
 * do the work; nothing but the operation itself is written before Confirm):
 *
 *   /operations/:id/validate  { sessionId, revision, values, lines? }  the fields changed since the block shown
 *                             (Increment 7: a document's whole line list, when it changed)
 *   /operations/:id/review    { sessionId, revision }          the form becomes its review card
 *   /operations/:id/edit      { sessionId, revision }          the review card's revision: back to its form
 *   /operations/:id/cancel    { sessionId }
 *   /operations/:id/status    { sessionId }                    the form, review or result as it is now
 *   /lookup                   { sessionId, operationId, field, q, module? }
 *                             the records one reference field of an open form may take
 *
 * Gates, in order: bot.use, bot_enabled, the visualAnswers and workflows
 * switches, 120 form requests a minute per user, the body (400), the
 * operation id (400), the identity from the verified login only (as /view),
 * the roleId rule (403), the tenant still active (403), and the assistant
 * engine On for the tenant (403 WORKFLOWS_OFF): guided forms need all three
 * (L7). sessionId is the browser's own chat id: the operation is looked up
 * under "<userId>.<sessionId>", namespaced exactly as /crm-chat forwards it,
 * so a request never reaches another user's form. Validate, review, edit
 * and lookup refuse a switched company (409); cancel and status answer in
 * any.
 *
 * 200: FormActionResult { block: form | review | result, notices,
 * confirmation? } (a review carries the confirmation Confirm sends back), or
 * LookupResult. A refusal is { success: false, message } with the step's
 * own status, plus `data` (a FormActionResult) when it comes with the
 * latest block: a stale revision gets the form as it is now, a form already
 * sent for review its review card. Every block sent is checked as every
 * chat block is (schema, caps, app links), fail closed: 500 "Couldn't show
 * this form. Try again." One log line per request: ids, step, status,
 * outcome and field keys; never a value or the search text. */

type FormStep = 'validate' | 'review' | 'edit' | 'cancel' | 'status';

const FORM_NOT_SHOWN = "Couldn't show this form. Try again.";

/** One guided-form request's answer: a 200's data, or the refusal (with the
 * latest block when there is one). `outcome` is for the log line. */
type FormRouteReply =
  | { http: 200; data: FormActionResult | LookupResult; outcome: string }
  | { http: 400 | 403 | 404 | 409 | 500; message: string; data?: FormActionResult; outcome: string };

/** Logs a reply that failed its check: the issue's keys, never a value. */
type OnInvalid = (issue: string) => void;

const formGates = [
  requirePermission('bot.use'),
  requireModuleEnabled('bot_enabled'),
  requireCrmAssistantFeature('visualAnswers'),
  requireCrmAssistantFeature('workflows'),
  crmAssistFormRateLimit,
];

const notShown = (): FormRouteReply => ({ http: 500, message: FORM_NOT_SHOWN, outcome: 'invalid_reply' });

function invalidFormRequest(what: FormStep | 'lookup', issue: ZodIssue | undefined): FormRouteReply {
  return {
    http: 400, outcome: 'invalid_body',
    message: `Invalid ${what} request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? 'is invalid'}`.trim(),
  };
}

/** Steps 8 to 12: the caller from the verified login only (the fields /view
 * and the chat's internalAuth token use), the roleId rule, the tenant still
 * active, the assistant engine On (the gates checked the two switches), and
 * the chat session namespaced under the signed-in user. */
async function formCaller(req: AuthRequest, clientSessionId: string): Promise<{ caller: WorkflowCaller } | { refused: FormRouteReply }> {
  const identity: AssistIdentity = {
    tenantId: req.tenantId!,
    userId: req.user!.userId,
    role: req.user!.role,
    ...(req.user!.roleId ? { roleId: req.user!.roleId } : {}),
    branchId: req.branchId ?? null,
  };
  if (!meetsRoleIdRule(identity)) return { refused: { http: 403, message: 'Insufficient permissions', outcome: 'role' } };
  const tenant = await loadGatewayTenant(identity.tenantId);
  if (isTenantBlocked(tenant, identity)) return { refused: { http: 403, message: TENANT_INACTIVE_MESSAGE, outcome: 'tenant_inactive' } };
  if (engineModeFor(identity.tenantId) !== 'on') return { refused: { http: 403, message: WORKFLOWS_OFF_MESSAGE, outcome: 'workflows_off' } };
  return { caller: { identity, tenant, sessionId: namespacedSessionId(identity.userId, clientSessionId), url: req.originalUrl } };
}

/** A FormActionResult as the browser may get it: the contract (schema and
 * caps) and only the app's own links, as every chat block; else null. */
function checkedFormResult(result: FormActionResult, onInvalid: OnInvalid): FormActionResult | null {
  const parsed = FormActionResultSchema.safeParse(result);
  if (!parsed.success) {
    onInvalid(parsed.error.issues[0]?.path.join('.') || 'body');
    return null;
  }
  if (collectLinks(parsed.data).some((path) => !isKnownAppLink(path))) {
    onInvalid('link');
    return null;
  }
  return parsed.data;
}

/** The answer to one step's WorkflowReply: its block (a review with its
 * confirmation), or the refusal with its own status and words, plus its
 * block when it has one. A start's notices and choices never come from
 * these steps. */
function formStepReply(reply: WorkflowReply, onInvalid: OnInvalid): FormRouteReply {
  if (reply.kind === 'form' || reply.kind === 'review' || reply.kind === 'result') {
    const data = checkedFormResult({
      block: reply.block, notices: reply.notices.slice(0, FORM_CAPS.notices),
      ...(reply.kind === 'review' ? { confirmation: reply.confirmation } : {}),
    }, onInvalid);
    if (!data) return notShown();
    return { http: 200, data, outcome: data.block.type === 'result' ? data.block.status : data.block.type };
  }
  if (reply.kind === 'refused') {
    // The refusal stands even when its block can't be shown: only the block is left out.
    const data = reply.block ? checkedFormResult({ block: reply.block, notices: [] }, onInvalid) : null;
    return { http: reply.http, message: reply.message, outcome: 'refused', ...(data ? { data } : {}) };
  }
  onInvalid(`reply ${reply.kind}`);
  return notShown();
}

/** A lookup's answer as the browser may get it (schema, caps, links), fail closed. */
function checkedLookupReply(result: LookupResult, onInvalid: OnInvalid): FormRouteReply {
  const parsed = LookupResultSchema.safeParse(result);
  if (!parsed.success) {
    onInvalid(parsed.error.issues[0]?.path.join('.') || 'body');
    return notShown();
  }
  if (collectLinks(parsed.data).some((path) => !isKnownAppLink(path))) {
    onInvalid('link');
    return notShown();
  }
  return { http: 200, data: parsed.data, outcome: parsed.data.state.status };
}

function onInvalidFor(req: AuthRequest, step: FormStep | 'lookup', operationId: string): OnInvalid {
  return (issue) => logger.error('CRM assist form: a reply failed its check and was not sent', {
    tenantId: req.tenantId, userId: req.user?.userId, operationId, step, issue,
  });
}

function logFormRequest(
  req: AuthRequest, at: { step: FormStep | 'lookup'; operationId?: string; fieldKeys: string[]; module?: string }, reply: FormRouteReply,
  started: number,
): void {
  logger.info('CRM assist form step', {
    tenantId: req.tenantId, userId: req.user?.userId, ...(at.operationId ? { operationId: at.operationId } : {}),
    step: at.step, http: reply.http, outcome: reply.outcome,
    ...(at.fieldKeys.length ? { fieldKeys: at.fieldKeys } : {}), ...(at.module ? { module: at.module } : {}),
    durationMs: Date.now() - started, llmCalls: 0,
  });
}

function sendFormReply(res: Response, reply: FormRouteReply): void {
  if (reply.http === 200) {
    sendSuccess(res, reply.data, 'OK');
    return;
  }
  // A refusal with the latest block: the browser shows that block with the message.
  if (reply.data) {
    res.status(reply.http).json({ success: false, message: reply.message, data: reply.data });
    return;
  }
  sendError(res, reply.message, reply.http);
}

/** One step of an open form (POST /operations/:id/<step>), after the gates. */
function formStepRoute<B extends { sessionId: string }>(
  step: FormStep, schema: ZodType<B>, run: (operationId: string, body: B, caller: WorkflowCaller) => Promise<WorkflowReply>,
  fieldKeysOf: (body: B) => string[] = () => [],
) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const started = Date.now();
    try {
      // Logged only when it is an operation id: a malformed one is the caller's own text.
      const operationId = OPERATION_ID_RE.test(String(req.params.id ?? '')) ? String(req.params.id) : undefined;
      const body = schema.safeParse(req.body);
      let reply: FormRouteReply;
      if (!body.success) reply = invalidFormRequest(step, body.error.issues[0]);
      else if (!operationId) reply = { http: 400, message: 'Invalid operation id', outcome: 'invalid_id' };
      else {
        const who = await formCaller(req, body.data.sessionId);
        reply = 'refused' in who
          ? who.refused
          : formStepReply(await run(operationId, body.data, who.caller), onInvalidFor(req, step, operationId));
      }
      logFormRequest(req, { step, ...(operationId ? { operationId } : {}), fieldKeys: body.success ? fieldKeysOf(body.data) : [] }, reply, started);
      sendFormReply(res, reply);
    } catch (err) {
      next(err);
    }
  };
}

// A document's whole line list (Increment 7) goes with the values when it changed; the log names it as `lines`.
router.post('/operations/:id/validate', ...formGates, formStepRoute('validate', FormValidateRequestSchema,
  (id, body, caller) => validateDraft(id, { revision: body.revision, values: body.values, ...(body.lines ? { lines: body.lines } : {}) }, caller),
  (body) => [...Object.keys(body.values), ...(body.lines ? ['lines'] : [])]));
router.post('/operations/:id/review', ...formGates, formStepRoute('review', FormRevisionRequestSchema,
  (id, body, caller) => reviewDraft(id, { revision: body.revision }, caller)));
router.post('/operations/:id/edit', ...formGates, formStepRoute('edit', FormRevisionRequestSchema,
  (id, body, caller) => editStaged(id, { revision: body.revision }, caller)));
router.post('/operations/:id/cancel', ...formGates, formStepRoute('cancel', FormSessionRequestSchema,
  (id, _body, caller) => cancelWorkflow(id, caller)));
router.post('/operations/:id/status', ...formGates, formStepRoute('status', FormSessionRequestSchema,
  (id, _body, caller) => workflowStatus(id, caller)));

/** The record picker of an open form (operations/lookup.ts): bound to the
 * caller's own draft and one of its reference fields, at most 10 records. */
router.post('/lookup', ...formGates,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const started = Date.now();
    try {
      const body = LookupRequestSchema.safeParse(req.body);
      let reply: FormRouteReply;
      if (!body.success) reply = invalidFormRequest('lookup', body.error.issues[0]);
      else {
        const who = await formCaller(req, body.data.sessionId);
        if ('refused' in who) reply = who.refused;
        else {
          const { operationId, field, q, module } = body.data;
          const found = await lookupForDraft({ operationId, field, q, ...(module ? { module } : {}) }, who.caller);
          reply = found.http === 200
            ? checkedLookupReply(found.result, onInvalidFor(req, 'lookup', operationId))
            : { http: found.http, message: found.message, outcome: 'refused' };
        }
      }
      // The field and module are keys; the search text is never logged.
      logFormRequest(req, body.success
        ? { step: 'lookup', operationId: body.data.operationId, fieldKeys: [body.data.field], ...(body.data.module ? { module: body.data.module } : {}) }
        : { step: 'lookup', fieldKeys: [] }, reply, started);
      sendFormReply(res, reply);
    } catch (err) {
      next(err);
    }
  });

export default router;
