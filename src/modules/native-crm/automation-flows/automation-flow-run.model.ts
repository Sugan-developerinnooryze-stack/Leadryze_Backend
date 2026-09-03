import mongoose, { Schema, Document } from 'mongoose';
import { IFlowNode, IFlowEdge } from './automation-flow.model';

/** Execution history for the Advanced Mode engine — one document per firing
 * of an AutomationFlow, with a per-node step log. Not the same document as
 * the AI chatbot's own `AutomationRun` (`modules/automation/automation-run.model.ts`)
 * — that's a different product surface (chat-session automation), a similar
 * shape by coincidence, not a shared collection.
 *
 * `status: 'paused'` (Delay) is the one status that persists real resumable
 * state (`pausedAt`/`resumeAt` below) rather than just a final outcome — see
 * automation-flow.service.ts's resumeFlow()/pollPausedFlows(), which is what
 * actually reads and clears it. Every other status is terminal or transient. */

export type FlowRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'paused';
export type FlowRunStepStatus = 'success' | 'failed' | 'skipped';

export interface IFlowRunStep {
  nodeId:    string;
  nodeType:  'trigger' | 'action' | 'condition' | 'delay' | 'merge' | 'subFlow' | 'loop' | 'approval';
  /** Human-readable description of what this node IS, e.g. "Condition: expectedRevenue > 50000"
   * or "Send Email" or "Create task record" — resolved once at log time so
   * the history stays readable even if the flow is edited/renamed later. */
  label:      string;
  status:     FlowRunStepStatus;
  startedAt:  Date;
  finishedAt?: Date;
  durationMs?: number;
  error?:     string;
  /** Free-text outcome, e.g. "true" / "false" for a condition, "sent" /
   * "skipped: no resolvable recipient" for a send, or a created record's
   * human-readable id for create_linked_record. */
  result?:    string;
  /** The resolved template variables at the moment this step ran (only
   * present for send_* steps) — lets you see exactly what values a
   * template was rendered with, without needing to re-derive them. */
  variables?: Record<string, string>;
  createdRecordModule?: string;
  createdRecordId?:     string;
  /** 1-based attempt index — present only for a node whose retryCount > 0.
   * A node that fails twice then succeeds produces three step entries
   * sharing one nodeId (attempt 1 failed, attempt 2 failed, attempt 3
   * success), not one collapsed step — this is what lets the history read
   * as "Send Email → Failed → Retry → Success" rather than a single
   * ambiguous status. Omitted (not 1) for any node that never retries, so
   * the common case's steps look exactly as they did before Retry existed. */
  attempt?: number;
  /** Present only for a step executed inside a parallel branch (Parallel +
   * Merge) — `forkId` is the id of the node whose edges produced the fork
   * (a synthetic label, not necessarily a single real node when the fork
   * came from the trigger's own fan-out), `branchIndex` is 0-based, matching
   * the fork's edge order. Absent for every non-parallel flow's steps and
   * for the merge node's own step — this lets a flat, execution-order-
   * interleaved `steps[]` array still be regrouped into clean per-branch
   * timelines later, without needing `steps` to become nested. */
  forkId?: string;
  branchIndex?: number;
  /** Present only for a step executed inline as part of a Sub-Flow
   * invocation (Sub-Flow, and later Loop) — the id of the node that
   * initiated the call (a `subFlow` node, or a `loop` node invoking its body
   * once per item). Absent for every ordinary step, so existing runs' logs
   * stay byte-identical. Coexists with forkId/branchIndex when a fork
   * happens INSIDE a called sub-flow's own body. */
  subFlowNodeId?: string;
  /** Present only for a step executed as one iteration of a Loop node's own
   * per-item Sub-Flow invocation — 0-based, the item's position in the
   * overall matched set (not per-page/per-chunk). Absent for a plain,
   * non-loop Sub-Flow call. */
  loopIterationIndex?: number;
}

/** Everything the loop-runner needs to resume exactly where it left off —
 * a full snapshot, not a live re-fetch-by-id (same "point in time, stays
 * meaningful even if the source has since changed" philosophy as flowName
 * above). Present only while status === 'paused'; cleared once resumed.
 * Named `pauseState`, not `pausedAt` — every other `...At` field in this
 * file is a timestamp, and this one is a whole snapshot object. */
export interface IFlowPauseState {
  /** The node id to resume AT — the delay node's own single outgoing edge
   * target, precomputed at pause time. Not used for an 'approval' pause
   * (which has TWO possible resume targets depending on the decision) — see
   * `pausedNodeId` below. */
  cursor?: string;
  currentRecord:  Record<string, any>;
  currentModule:  string;
  depth:          number;
  hadSkip:        boolean;
  /** The original trigger's resolved stage/outcome value (e.g. a status key,
   * or 'created'/'deleted') — needed verbatim by buildVariables()'s `{{status}}`
   * substitution for any send_* node reached after resuming. */
  toStage:        string;
  /** Absent = 'delay' (preserves byte-identical behavior for every run
   * paused before Approval existed). 'approval' means this pause resumes via
   * an explicit decision call (decideApproval()), never a timer — resumeAt
   * is never set for this kind, so the existing Delay-resume poll
   * (`{status:'paused', resumeAt:{$lte:now}}`) naturally never matches it. */
  kind?: 'delay' | 'approval';
  /** Only meaningful when kind === 'approval' — the Approval node's own id,
   * since (unlike Delay) it has TWO possible next-cursors depending on the
   * decision (the 'approve'/'reject'-tagged edge), resolved at decision time
   * by looking up this node's own outgoing edges rather than a single
   * precomputed cursor. */
  pausedNodeId?: string;
}

export interface IAutomationFlowRun extends Document {
  tenantId:      mongoose.Types.ObjectId;
  flowId:        mongoose.Types.ObjectId;
  /** Snapshot of the flow's name at run time — stays meaningful even if the
   * flow is later renamed or deleted. */
  flowName:      string;
  /** The published version this run actually executed (AutomationFlow.version
   * at trigger time) — stays meaningful across later publishes, same
   * "point-in-time snapshot" reasoning as flowName. Absent on runs recorded
   * before versioning existed. */
  flowVersion?:  number;
  status:        FlowRunStatus;
  triggerModule: string;
  triggerRecordId?: string;
  startedAt:     Date;
  finishedAt?:   Date;
  durationMs?:   number;
  steps:         IFlowRunStep[];
  /** Only present while status === 'paused' — see IFlowPauseState. */
  pauseState?:   IFlowPauseState;
  /** Only present while status === 'paused' — when pollPausedFlows() should
   * next attempt to resume this run. */
  resumeAt?:     Date;
  /** Set to the CURRENTLY EXECUTING run's own _id whenever this run was
   * itself triggered as a downstream consequence of that run's action
   * (update_record/assign_record/change_status/create_linked_record calling
   * runAutomationsOnUpdate/runFlowsOnUpdate or runAutomationsOnCreate/
   * runFlowsOnCreate). Absent for a run that started from a genuine external
   * trigger (a real record edit, a schedule tick, a webhook delivery).
   * Additive traceability only — MAX_LINKED_RECORD_CHAIN_DEPTH (enforced via
   * the separate `depth` counter threaded through the runFlowsOnX/
   * runAutomationsOnX hooks, not this field) is what actually bounds a
   * self-triggering chain; this
   * just makes that chain directly queryable
   * (`AutomationFlowRun.find({triggeredByRunId: X})`) instead of an
   * inference reconstructed from timestamps. */
  triggeredByRunId?: mongoose.Types.ObjectId;
  /** A pinned copy of the flow's nodes/edges as of the moment THIS run was
   * created — populated unconditionally by executeFlow(), read back by
   * resumeFlow()/decideApproval() instead of a fresh AutomationFlow.findOne()
   * fetch. Exists so a Delay/Approval-paused run stays bound to the graph it
   * started with even if the flow is published to a new version while the
   * run sits paused — without this, resumeFlow's own live re-fetch would
   * silently execute the NEW graph using the OLD run's pauseState.cursor (a
   * node id that may not even exist in the new version, or whose config
   * simply changed underneath the paused run). Sub-Flow/Loop callee flows
   * are deliberately NOT covered by this snapshot — they're fetched fresh at
   * the moment they're actually invoked (inside invokeFlowInline), which is
   * correct as-is since a Sub-Flow/Loop call is never itself a
   * pause-then-resume-later boundary. */
  flowSnapshot?: { nodes: IFlowNode[]; edges: IFlowEdge[] };
  createdAt:     Date;
  updatedAt:     Date;
}

const stepSchema = new Schema<IFlowRunStep>(
  {
    nodeId:    { type: String, required: true },
    nodeType:  { type: String, enum: ['trigger', 'action', 'condition', 'delay', 'merge', 'subFlow', 'loop', 'approval'], required: true },
    label:     { type: String, required: true },
    status:    { type: String, enum: ['success', 'failed', 'skipped'], required: true },
    startedAt:  { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    error:      { type: String },
    result:     { type: String },
    variables:  { type: Schema.Types.Mixed },
    createdRecordModule: { type: String },
    createdRecordId:     { type: String },
    attempt:             { type: Number },
    forkId:              { type: String },
    branchIndex:         { type: Number },
    subFlowNodeId:       { type: String },
    loopIterationIndex:  { type: Number },
  },
  { _id: false },
);

const pauseStateSchema = new Schema<IFlowPauseState>(
  {
    cursor:        { type: String },
    currentRecord: { type: Schema.Types.Mixed, required: true },
    currentModule: { type: String, required: true },
    depth:         { type: Number, required: true },
    hadSkip:       { type: Boolean, required: true },
    toStage:       { type: String, required: true },
    kind:          { type: String, enum: ['delay', 'approval'] },
    pausedNodeId:  { type: String },
  },
  { _id: false },
);

const schema = new Schema<IAutomationFlowRun>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    flowId:        { type: Schema.Types.ObjectId, ref: 'AutomationFlow', required: true },
    flowName:      { type: String, required: true },
    flowVersion:   { type: Number },
    status:        { type: String, enum: ['running', 'completed', 'partial', 'failed', 'paused'], default: 'running' },
    triggerModule: { type: String, required: true },
    triggerRecordId: { type: String },
    startedAt:     { type: Date, required: true },
    finishedAt:    { type: Date },
    durationMs:    { type: Number },
    steps:         { type: [stepSchema], default: [] },
    pauseState:    { type: pauseStateSchema },
    resumeAt:      { type: Date },
    triggeredByRunId: { type: Schema.Types.ObjectId, ref: 'AutomationFlowRun' },
    // Mixed, not a strict sub-schema — flowSnapshot is server-computed only
    // (never client-writable, same posture as pauseState.currentRecord
    // above), so it doesn't need Mongoose-level structural validation.
    flowSnapshot:  { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, flowId: 1, createdAt: -1 });
schema.index({ tenantId: 1, status: 1 });
// Serves pollPausedFlows()'s cross-tenant scan directly — not scoped by
// tenantId since the poll itself runs globally, once per cron tick.
schema.index({ status: 1, resumeAt: 1 });
// Sparse — most runs have no triggeredByRunId (a genuine external trigger,
// not a downstream re-fire). Serves the self-recursion trace query directly.
schema.index({ triggeredByRunId: 1 }, { sparse: true });
// Serves getFlowRunStats()'s $facet aggregation (Phase 5) — none of the
// indexes above cover `startedAt`, so both the perFlow branch's own
// $sort:{startedAt:-1} (needed for its $first "most recent" trick) and the
// todaySummary branch's $match:{startedAt:{$gte:...}} would otherwise fall
// back to an in-memory sort/scan as this collection grows.
schema.index({ tenantId: 1, startedAt: -1 });

export const AutomationFlowRun = mongoose.model<IAutomationFlowRun>(
  'AutomationFlowRun',
  schema,
  'native_automation_flow_runs',
);
