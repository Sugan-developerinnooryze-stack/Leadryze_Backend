import mongoose, { Schema, Document } from 'mongoose';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';
import { IFieldMapping, AutomationRecipientStrategy, AutomationTriggerType, AutomationActionType, IFlowCondition } from '../automation-rules/automation-rule.model';

/** "Advanced Mode" — a chain of nodes (trigger, then actions and — as of
 * step 2 — conditions), distinct from `AutomationRule` ("Simple Mode", one
 * trigger + one action, untouched and still the default for most tenants).
 * Deliberately NOT named "workflow" — that name is taken by the unrelated
 * document-progression engine in `native-crm/workflow/` (quotation → contract
 * → work order → invoice step ordering), a fixed concept with nothing to do
 * with tenant-configurable automation chains.
 *
 * v1 scope was a strictly linear chain. Later updates added condition nodes
 * (branch into a TRUE and/or FALSE path via each outgoing edge's `fromPort`
 * — the shape is a branching TREE rooted at the trigger, not a flat line:
 * every node still has at most one INCOMING edge except a `merge` node,
 * see below), action nodes' own success/failure branching (Error Branch,
 * same `fromPort` mechanism, different vocabulary), a delay node (pauses the
 * run — see automation-flow-run.model.ts's `pauseState`/`resumeAt` and this
 * file's own service's `resumeFlow()`/`pollPausedFlows()`), and Parallel +
 * Merge (any node whose outgoing edges used to cap at ≤1 per port instead
 * allows N — "do all of these concurrently" — converging back at a `merge`
 * node, which is config-free and simply waits for every incoming edge to
 * arrive before continuing via its own single outgoing edge; v1 requires a
 * flat, non-nested fork→merge shape with no delay/branching along the way —
 * see automation-flow.service.ts's assertValidForkMergeShape()). Delay's own
 * outgoing edge stays capped at exactly 1, unconditionally — it never
 * becomes a fork point itself, since the pause/resume mechanism has no way
 * to represent multiple independently-paused branches. Sub-Flow (`subFlow`)
 * lets one flow invoke another (`targetFlowId`) as a single inline step,
 * under a strict two-tier hierarchy enforced at save time — a "caller" flow
 * may contain `subFlow` nodes, a "callee" flow (referenced as someone's
 * target) may not itself contain `subFlow`/`delay`/`approval` nodes, never
 * both — see automation-flow.service.ts's createFlow()/updateFlow()/
 * deleteFlow() for the two symmetric checks this enforces. This makes
 * cross-flow cycles/unbounded nesting structurally impossible rather than
 * merely depth-capped. Loop (`loop`) iterates a matching set of records,
 * invoking a Sub-Flow once per item — see LoopSourceModule's own comment
 * below. Approval (`approval`) pauses a run waiting for a human decision
 * (Approve/Reject, via `fromPort` — the same mechanism as condition's
 * true/false or Error Branch's success/failure, its own disjoint
 * vocabulary), reusing Delay's exact `pauseState`/`status:'paused'` shape
 * (see automation-flow-run.model.ts's `IFlowPauseState.kind`/`pausedNodeId`)
 * but resuming via an explicit decision call (`decideApproval()`) instead of
 * a timer — no new cron job, `resumeAt` simply stays absent for an
 * Approval pause so the existing Delay-resume poll naturally never touches
 * it. Same non-forking, non-parallel-branch-eligible, non-Sub-Flow-callee-
 * eligible restriction as delay/subFlow/loop — an Approval node's own
 * pause can't coexist with fork/inline-invocation mechanics either.
 * See automation-flow.service.ts's assertValidFlowShape() for the exact
 * rules this is validated against.
 */

export type FlowNodeType = 'trigger' | 'action' | 'condition' | 'delay' | 'merge' | 'subFlow' | 'loop' | 'approval';

/** Superset of PipelineModule used only by Loop's loopSourceModule field —
 * NativeCustomer is a real, tenant-scoped, queryable module but is
 * deliberately NOT part of the closed PipelineModule union used everywhere
 * else in these two engines (no stage/pipeline concept, not a valid
 * create_linked_record target). Rather than widen PipelineModule itself —
 * a cross-cutting change touching the Zod module schema, getFieldCatalog,
 * createRecordInTargetModule, and resolveAutomationRecipient, all of which
 * assume "8 built-ins + custom: is the complete set" — Loop gets its own
 * narrower type and its own small query dispatcher (queryLoopItems in
 * automation-flow.service.ts). */
export type LoopSourceModule = PipelineModule | 'customer';

// ConditionOperator/IFlowCondition now live in automation-rule.model.ts (the
// established one-directional shared-primitives home) — Schedule Trigger's
// scheduleFilter needs the same shape on AutomationRule, and this file
// already imports several other shared primitives from there.

export interface IFlowNode {
  /** Client-generated, stable within this flow (e.g. 'n1', 'n2') — referenced
   * by edges below. Not a Mongo _id; nodes are a plain array, not a
   * sub-collection, so re-ordering/editing never needs a stable Mongo id. */
  id: string;
  type: FlowNodeType;

  // ── Trigger node fields (present only when type === 'trigger') ──────────
  /** The module this flow listens to — same PipelineModule/`custom:<slug>`
   * convention as AutomationRule. */
  module?: PipelineModule;
  triggerType?: AutomationTriggerType;
  triggerStage?: string;
  triggerField?: string;
  /** Only meaningful when triggerType === 'scheduled' — see
   * automation-rule.model.ts's matching fields for the full doc, shared
   * verbatim between both engines. */
  scheduleCron?:        string;
  scheduleModule?:      PipelineModule;
  scheduleFilter?:      IFlowCondition[];
  scheduleLastFiredAt?: Date;
  scheduleCursor?:      string;
  /** Only meaningful when triggerType === 'webhook' — see
   * automation-rule.model.ts's matching field for the full doc, shared
   * verbatim between both engines. */
  webhookToken?:        string;
  /** Phase 6 branch scoping — Branch document ids (this tenant's own,
   * validated at save time). Absent/empty = unscoped, matches every branch
   * (today's exact behavior, so every pre-existing flow is unaffected).
   * When present, a record whose own `branchId` is null never matches (see
   * matchesBranchScope in automation-rule.service.ts, the shared home for
   * both engines) — not meaningful on a `triggerType:'webhook'` node (no
   * record, no branch concept), rejected at save time if set there. See
   * automation-rule.model.ts's matching field for the full doc, shared
   * verbatim between both engines. */
  branchIds?: string[];

  // ── Action node fields (present only when type === 'action') ────────────
  actionType?: AutomationActionType;
  templateId?: string;
  recipientStrategy?: AutomationRecipientStrategy;
  targetModule?: string;
  fieldMappings?: IFieldMapping[];
  backReferenceField?: string;
  /** Retry — only meaningful on action nodes (enforced in assertValidNodes).
   * Number of retries AFTER the first attempt, so `3` means up to 4 total
   * attempts; `0`/absent is today's exact pre-Retry behavior (fail/skip on
   * the first attempt, no waiting). Only the node's own core action call is
   * retried — never the bookkeeping that runs after a successful attempt
   * (audit log, cascading triggers) — see executeFlow()'s retry loop. */
  retryCount?: 0 | 1 | 2 | 3;
  /** Fixed delay between attempts (not exponential) — one of 4 presets.
   * Meaningless when retryCount is 0/absent. */
  retryBackoffMs?: 1000 | 5000 | 30000 | 60000;

  // ── Add Note action fields (actionType === 'add_note' only) ─────────────
  /** Required — NativeActivity.subject, template-rendered. */
  noteSubject?: string;
  /** Optional, template-rendered — NativeActivity.description. */
  noteBody?: string;
  /** Optional — NativeActivity.assignedTo (a plain string on that model,
   * same as it is there — no FK typing to match). */
  noteAssignedTo?: string;

  // ── Webhook action fields (actionType === 'webhook_call' only) ──────────
  /** Required. Validated both at save time (automation-flow.validation.ts's
   * superRefine, best-effort — an obviously-bad URL is rejected in the
   * builder) and, authoritatively, immediately before every actual call
   * (including every retry) via resolveAndPinSafeUrl (utils/url-safety.ts)
   * — DNS can legitimately change between the two. */
  webhookUrl?: string;
  webhookMethod?: 'POST' | 'PUT' | 'PATCH';
  /** A sensitive-named entry's `value` (see webhook-secret.util.ts's
   * SENSITIVE_HEADER_NAMES) is encrypted at rest on save and never returned
   * by any GET — only a fixed masked placeholder is. Body reuses the
   * existing fieldMappings field below (same readSourceField/
   * setPayloadField machinery create_linked_record already uses) — no
   * separate "webhook body" field. */
  webhookHeaders?: { key: string; value: string }[];

  // ── Condition node fields (present only when type === 'condition') ──────
  /** AND-combined in v1 (every condition must pass) — matches the array
   * shape of the spec doc this was built from; OR/grouping isn't supported
   * yet, not requested. */
  conditions?: IFlowCondition[];

  // ── Delay node fields (present only when type === 'delay') ──────────────
  /** Bounded 1–129600 (90 days) so a run can't accidentally stay paused
   * forever. A plain bounded number, not Retry's strict preset enum —
   * deliberately: a reminder delay is genuinely business-specific ("5
   * minutes" vs "30 days" vs anything between), unlike a technical retry
   * backoff where a small fixed preset set is the whole point. */
  delayMinutes?: number;

  // ── Sub-Flow node fields (present only when type === 'subFlow') ─────────
  /** The callee flow to invoke inline, once, as this single step — validated
   * at save time (createFlow/updateFlow) to belong to the same tenant, exist,
   * and itself contain no subFlow/delay/approval node (the two-tier hierarchy
   * — see this file's top comment). Executed inline into the SAME
   * AutomationFlowRun document (steps tagged with this node's own id via
   * subFlowNodeId on IFlowRunStep), not as a separate run. */
  targetFlowId?: string;

  // ── Loop node fields (present only when type === 'loop') ────────────────
  /** Which module to iterate — PipelineModule plus 'customer' (see
   * LoopSourceModule's own comment on why Customer isn't just added to
   * PipelineModule itself). */
  loopSourceModule?: LoopSourceModule;
  /** AND-combined, same shape/operators as a condition node — compiled to a
   * real Mongo query (conditionsToMongoFilter), same as Schedule Trigger's
   * own scheduleFilter. Omitted/empty = every record in the module matches. */
  loopFilter?: IFlowCondition[];
  /** The callee to invoke once per matching item — same targetFlowId
   * validation/two-tier-hierarchy rules as a plain subFlow node's own field. */
  loopSubFlowId?: string;
  /** Tenant-configurable safety ceiling on the TOTAL item count this Loop
   * node will ever process in one run (bounded to a hard system ceiling —
   * see automation-flow.validation.ts). Unlike Schedule Trigger's fixed,
   * non-configurable MAX_SCHEDULE_MATCHES_PER_TICK, this is exposed as a
   * real per-node setting — this is what the user's own "Stop Condition"
   * config knob means: a cap on total items, not a live mid-loop conditional
   * exit. If more records match than this, only the first loopMaxItems
   * (stable _id ascending order) are processed and a warning is logged. */
  loopMaxItems?: number;
  /** How many matching items are fetched from the database per query
   * round-trip (paging granularity — relevant once loopMaxItems is large). */
  loopBatchSize?: number;
  /** How many of the CURRENTLY FETCHED page's items have their Sub-Flow
   * invocation in flight at once — each page's items are processed in
   * chunks of this size, one chunk fully settled via Promise.allSettled
   * before the next chunk starts. */
  loopConcurrency?: number;

  // ── Approval node fields (present only when type === 'approval') ───────
  /** Who gets notified to make the decision — reuses AutomationRecipientStrategy
   * verbatim (the same type both engines already share); 'manager' is the
   * strategy this node type actually needs (see automation-rule.model.ts's
   * own comment on why), but any existing strategy is technically valid too. */
  approvalRecipientStrategy?: AutomationRecipientStrategy;
}

export interface IFlowEdge {
  from: string;
  to: string;
  /** A condition node's outgoing edges use 'true'/'false'; an action node's
   * use 'success'/'failure' (Error Branch); an approval node's use
   * 'approve'/'reject' — each node type has its own, disjoint vocabulary,
   * enforced in assertValidFlowShape(), not expressible in this union alone.
   * Either way, an untagged edge (undefined) means "the only, unconditional
   * path forward" and is mutually exclusive with having any tagged edges on
   * that same node — a node can't mix "always go here" with "go here only
   * on X". Trigger nodes never carry a fromPort. */
  fromPort?: 'true' | 'false' | 'success' | 'failure' | 'approve' | 'reject';
}

/** A staged, unpublished copy of the whole graph — same shape as the live
 * nodes/edges/canvasPositions, never a partial diff. Present only while
 * there's an edit pending publish; absent the rest of the time (including
 * for every flow that predates versioning — an absent draft simply means
 * "nothing staged," which is also the correct, zero-migration reading for
 * pre-existing data). Trigger-matching queries (runFlows/runFlowsOnCreate/
 * etc in automation-flow.service.ts) only ever read the top-level nodes/
 * edges below, never this — so a draft can never accidentally fire before
 * it's published, without those query sites needing to know this exists. */
export interface IFlowDraft {
  nodes: IFlowNode[];
  edges: IFlowEdge[];
  canvasPositions?: Record<string, { x: number; y: number }>;
  updatedAt: Date;
}

export interface IAutomationFlow extends Document {
  tenantId:   mongoose.Types.ObjectId;
  name:       string;
  enabled:    boolean;
  /** The LIVE, executable graph — what every trigger-matching query and
   * executeFlow() itself reads. createFlow() writes here directly (a brand
   * new flow has no prior "published" behavior to protect); updateFlow()
   * on an EXISTING flow never touches this — it stages into `draft` below
   * instead, per publishFlow()'s own doc comment. */
  nodes:      IFlowNode[];
  edges:      IFlowEdge[];
  /** Per-node canvas position, keyed by node id — optional, populated once
   * an Advanced Mode canvas (build-order step 10) exists to drag nodes on.
   * Absent entirely until then; no auto-layout concept needed at the model
   * layer, that's a frontend rendering concern same as AutomationRule's own
   * canvasPosition. */
  canvasPositions?: Record<string, { x: number; y: number }>;
  /** Bumped only by publishFlow() — starts at 1 (the create-time content
   * counts as the implicit first published version). Stamped onto each
   * AutomationFlowRun (flowVersion) so execution history stays meaningful
   * across later publishes — "this run executed v3" even after v5 is live. */
  version:      number;
  publishedAt?: Date;
  draft?:       IFlowDraft;
  createdBy?: string;
  createdAt:  Date;
  updatedAt:  Date;
}

const fieldMappingSchema = new Schema<IFieldMapping>(
  {
    targetField: { type: String, required: true, trim: true },
    sourceType:  { type: String, enum: ['field', 'static'], required: true },
    sourceField: { type: String, trim: true },
    staticValue: { type: String },
  },
  { _id: false },
);

const webhookHeaderSchema = new Schema<{ key: string; value: string }>(
  {
    key:   { type: String, required: true, trim: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const flowConditionSchema = new Schema<IFlowCondition>(
  {
    field:    { type: String, required: true, trim: true },
    operator: {
      type: String, required: true,
      enum: ['=', '!=', '>', '<', '>=', '<=', 'contains', 'startsWith', 'endsWith', 'is_empty', 'is_not_empty', 'between', 'in_list', 'not_in_list'],
    },
    value:  { type: String },
    value2: { type: String },
  },
  { _id: false },
);

// Exported (was bare `const`) so automation-templates/automation-template.model.ts
// (Phase 4) can reuse these exact sub-schemas for its own nodes/edges fields
// rather than duplicating a ~90-line schema — purely additive, zero behavior
// change for anything already using this file.
export const flowNodeSchema = new Schema<IFlowNode>(
  {
    id:   { type: String, required: true, trim: true },
    type: { type: String, enum: ['trigger', 'action', 'condition', 'delay', 'merge', 'subFlow', 'loop', 'approval'], required: true },

    module:      { type: String, trim: true },
    triggerType: { type: String, enum: ['status_changed', 'record_created', 'record_updated', 'record_deleted', 'scheduled', 'webhook'] },
    triggerStage: { type: String, trim: true },
    triggerField: { type: String, trim: true },
    scheduleCron:        { type: String, trim: true },
    scheduleModule:      { type: String, trim: true },
    scheduleFilter:      { type: [flowConditionSchema], default: undefined },
    scheduleLastFiredAt: { type: Date },
    scheduleCursor:      { type: String },
    webhookToken:        { type: String, trim: true },
    branchIds:           { type: [String], default: undefined },

    actionType:        {
      type: String,
      enum: ['send_email', 'send_sms', 'send_whatsapp', 'create_linked_record', 'update_record', 'assign_record', 'change_status', 'add_note', 'webhook_call'],
    },
    templateId:        { type: String },
    recipientStrategy: { type: String, enum: ['record_contact', 'assigned_user', 'tenant_admin', 'manager'] },
    targetModule:       { type: String, trim: true },
    fieldMappings:      { type: [fieldMappingSchema], default: undefined },
    backReferenceField: { type: String, trim: true },
    retryCount:         { type: Number, enum: [0, 1, 2, 3] },
    retryBackoffMs:     { type: Number, enum: [1000, 5000, 30000, 60000] },

    noteSubject:     { type: String, trim: true },
    noteBody:        { type: String },
    noteAssignedTo:  { type: String, trim: true },

    webhookUrl:     { type: String, trim: true },
    webhookMethod:  { type: String, enum: ['POST', 'PUT', 'PATCH'] },
    webhookHeaders: { type: [webhookHeaderSchema], default: undefined },

    conditions: { type: [flowConditionSchema], default: undefined },

    delayMinutes: { type: Number, min: 1, max: 129600 },

    targetFlowId: { type: String, trim: true },

    loopSourceModule: { type: String, trim: true },
    loopFilter:       { type: [flowConditionSchema], default: undefined },
    loopSubFlowId:    { type: String, trim: true },
    loopMaxItems:     { type: Number, min: 1, max: 2000 },
    loopBatchSize:    { type: Number, min: 1 },
    loopConcurrency:  { type: Number, min: 1 },

    approvalRecipientStrategy: { type: String, enum: ['record_contact', 'assigned_user', 'tenant_admin', 'manager'] },
  },
  { _id: false },
);

export const flowEdgeSchema = new Schema<IFlowEdge>(
  {
    from:     { type: String, required: true, trim: true },
    to:       { type: String, required: true, trim: true },
    fromPort: { type: String, enum: ['true', 'false', 'success', 'failure', 'approve', 'reject'], trim: true },
  },
  { _id: false },
);

const flowDraftSchema = new Schema<IFlowDraft>(
  {
    nodes: { type: [flowNodeSchema], default: [] },
    edges: { type: [flowEdgeSchema], default: [] },
    canvasPositions: { type: Schema.Types.Mixed },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const schema = new Schema<IAutomationFlow>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name:     { type: String, required: true, trim: true },
    enabled:  { type: Boolean, default: true },
    nodes:    { type: [flowNodeSchema], default: [] },
    edges:    { type: [flowEdgeSchema], default: [] },
    canvasPositions: { type: Schema.Types.Mixed },
    version:      { type: Number, default: 1 },
    publishedAt:  { type: Date },
    draft:        { type: flowDraftSchema },
    createdBy: { type: String },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, enabled: 1 });
// Sparse + unique multikey index over the array field — enforces uniqueness
// across documents; a single flow can only ever have one trigger node
// (assertValidFlowShape), so at most one webhookToken value per document
// anyway. See automation-webhooks/automation-webhook.controller.ts.
schema.index({ 'nodes.webhookToken': 1 }, { unique: true, sparse: true });

export const AutomationFlow = mongoose.model<IAutomationFlow>(
  'AutomationFlow',
  schema,
  'native_automation_flows',
);
