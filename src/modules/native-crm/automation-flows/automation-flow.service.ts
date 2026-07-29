import mongoose from 'mongoose';
import { AutomationFlow, IAutomationFlow, IFlowNode, IFlowEdge, LoopSourceModule } from './automation-flow.model';
import { AutomationFlowRun, IFlowRunStep } from './automation-flow-run.model';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { getTemplateById, renderTemplate } from '../../templates/template.service';
import { sendEmailNow } from '../../messages/brevo.service';
import { sendSmsNow } from '../../messages/twilio.service';
import { sendWhatsAppNow } from '../../messages/whatsapp.service';
import { writeLog } from '../../notifications/email-log.service';
import { logger } from '../../../utils/logger';
import {
  getFieldCatalog, readSourceField, setPayloadField, resolveAutomationRecipient,
  buildVariables, createRecordInTargetModule, sourceIdentifierOf, MAX_LINKED_RECORD_CHAIN_DEPTH,
  conditionsToMongoFilter, MAX_SCHEDULE_MATCHES_PER_TICK, queryScheduleMatches, resolveComparableValue,
  generateWebhookToken,
} from '../automation-rules/automation-rule.service';
import { IFlowCondition } from '../automation-rules/automation-rule.model';
import cronParser from 'cron-parser';

/** "Advanced Mode" engine — see automation-flow.model.ts's top comment for
 * why this is a separate entity from AutomationRule ("Simple Mode") rather
 * than an extension of it. This file mirrors automation-rule.service.ts's
 * shape deliberately (same hook-function names with an "Flows" instead of
 * "s" suffix, same fire-and-forget/depth-cap contract) so the two engines
 * stay easy to reason about side by side, but reuses — rather than
 * reimplements — every actual execution primitive (imports above) so the
 * two engines can never quietly drift apart on how a template renders or a
 * recipient resolves. */

/* ── Structural validation (v1: branching TREE + flat fork→merge) ────────── */

/** Confirms the node/edge graph is exactly what v1 supports: one trigger
 * node, feeding a TREE of action/condition/merge nodes. Every node has at
 * most one INCOMING edge EXCEPT a `merge` node, which needs at least two (a
 * merge is the one deliberate exception to "tree" — see
 * assertValidForkMergeShape() below for the narrower rules governing WHICH
 * incoming edges a merge may legally have). A condition node may have any
 * number of outgoing edges per port ('true'/'false'), an action node any
 * number per port ('success'/'failure', Error Branch) or any number
 * untagged, and — as of Parallel + Merge — a trigger node may ALSO have any
 * number of outgoing edges (fan-out at the very start of a run). More than
 * one edge on the same port/untagged case is a FORK — see
 * assertValidForkMergeShape() for what's required of it. Delay is the one
 * exception that stays capped at exactly one outgoing edge, unconditionally
 * — it never becomes a fork point, since the pause/resume mechanism has no
 * way to represent multiple independently-paused branches. No cycles, no
 * orphaned nodes. This function is the one place the current shape
 * assumption lives — relaxing it further later means editing this function,
 * not hunting through the executor. */
function assertValidFlowShape(nodes: IFlowNode[], edges: IFlowEdge[]): void {
  const triggerNodes = nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length !== 1) {
    throw new Error(`A flow must have exactly one trigger node (found ${triggerNodes.length})`);
  }
  if (nodes.length < 2) {
    throw new Error('A flow needs at least one node after the trigger');
  }

  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) throw new Error('Node ids must be unique within a flow');
  for (const e of edges) {
    if (!ids.has(e.from)) throw new Error(`Edge references unknown node "${e.from}"`);
    if (!ids.has(e.to)) throw new Error(`Edge references unknown node "${e.to}"`);
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, IFlowEdge[]>();
  const inDegree = new Map<string, number>();
  for (const e of edges) {
    outEdges.set(e.from, [...(outEdges.get(e.from) ?? []), e]);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  for (const n of nodes) {
    const outs = outEdges.get(n.id) ?? [];
    const nodeInDegree = inDegree.get(n.id) ?? 0;

    if (n.type === 'merge') {
      if (nodeInDegree < 2) throw new Error(`Merge node "${n.id}" needs at least two incoming edges`);
      if (outs.length > 1) throw new Error(`Merge node "${n.id}" has more than one outgoing edge`);
      if (outs.some((e) => e.fromPort)) throw new Error(`Node "${n.id}" is a merge node — its outgoing edge cannot have a fromPort`);
      continue;
    }
    if (nodeInDegree > 1) throw new Error(`Node "${n.id}" has more than one incoming edge — only a merge node can`);

    if (n.type === 'condition') {
      const ports = outs.map((e) => e.fromPort);
      if (ports.some((p) => p !== 'true' && p !== 'false')) {
        throw new Error(`Condition node "${n.id}"'s outgoing edges must each be marked fromPort: 'true' or 'false'`);
      }
    } else if (n.type === 'action') {
      // Error Branch: an action node EITHER has only untagged edges (today's
      // exact pre-Error-Branch shape — "always go here next, regardless of
      // outcome") OR edges tagged 'success'/'failure' — never a mix, for the
      // same reason a condition node can't mix an unconditional edge with a
      // conditional one on itself. Any number of edges per port is now
      // allowed (Parallel + Merge fan-out) — see assertValidForkMergeShape().
      const ports = outs.map((e) => e.fromPort);
      const anyTagged = ports.some((p) => p !== undefined);
      if (anyTagged && ports.some((p) => p !== 'success' && p !== 'failure')) {
        throw new Error(`Action node "${n.id}"'s outgoing edges must each be marked fromPort: 'success' or 'failure' (or left untagged)`);
      }
    } else if (n.type === 'delay') {
      // Structurally simple like a trigger — waits, then continues to
      // exactly one place, never branches, never forks (see this function's
      // own top comment for why delay is the one deliberate exception).
      if (outs.length > 1) throw new Error(`Delay node "${n.id}" has more than one outgoing edge — delay nodes can't branch`);
      if (outs.some((e) => e.fromPort)) throw new Error(`Node "${n.id}" is a delay node — its outgoing edge cannot have a fromPort`);
    } else if (n.type === 'subFlow') {
      // Same shape as delay — a single inline call, never branches, never
      // forks (see this file's top comment on why Sub-Flow's own execution,
      // like delay's, can't coexist with the pause/resume or fork mechanism).
      if (outs.length > 1) throw new Error(`Sub-Flow node "${n.id}" has more than one outgoing edge — subFlow nodes can't branch`);
      if (outs.some((e) => e.fromPort)) throw new Error(`Node "${n.id}" is a subFlow node — its outgoing edge cannot have a fromPort`);
    } else if (n.type === 'loop') {
      // Same shape as delay/subFlow — a Loop node's own execution is fully
      // synchronous within one processOneNode call, so it can't coexist with
      // pause/resume or fork mechanics either.
      if (outs.length > 1) throw new Error(`Loop node "${n.id}" has more than one outgoing edge — loop nodes can't branch`);
      if (outs.some((e) => e.fromPort)) throw new Error(`Node "${n.id}" is a loop node — its outgoing edge cannot have a fromPort`);
    } else if (n.type === 'approval') {
      // Stricter than a condition node's own "up to two" edges — a decision
      // gate is only meaningful with BOTH outcomes wired (an approval with
      // no 'reject' edge would mean a rejection silently dead-ends the run,
      // a worse default for something this consequential than requiring
      // both paths up front). Exactly one 'approve' and one 'reject' edge,
      // never a duplicate — decideApproval() resolves the next cursor via
      // edges.find(e => e.from === node.id && e.fromPort === decision), so a
      // duplicate on either port would make that lookup ambiguous.
      const ports = outs.map((e) => e.fromPort);
      if (outs.length !== 2) {
        throw new Error(`Approval node "${n.id}" must have exactly two outgoing edges, tagged 'approve' and 'reject'`);
      }
      if (ports.some((p) => p !== 'approve' && p !== 'reject')) {
        throw new Error(`Approval node "${n.id}"'s outgoing edges must each be marked fromPort: 'approve' or 'reject'`);
      }
      if (new Set(ports).size !== ports.length) {
        throw new Error(`Approval node "${n.id}" has a duplicate fromPort — 'approve' and 'reject' may each appear at most once`);
      }
    } else {
      // trigger — may now fan out too (Parallel + Merge), still never tagged.
      if (outs.some((e) => e.fromPort)) throw new Error(`Node "${n.id}" is a trigger — its outgoing edge cannot have a fromPort`);
    }
  }

  const triggerId = triggerNodes[0].id;
  if ((inDegree.get(triggerId) ?? 0) !== 0) throw new Error('The trigger node cannot have an incoming edge');

  // Breadth-first walk from the trigger, confirming every node is reached
  // the right number of times — a tree except at merge nodes, which may
  // legitimately be reached once per incoming branch (up to their own
  // in-degree); every other node must be reached exactly once. A node's own
  // outgoing edges are only descended into (enqueued) the FIRST time it's
  // reached — never on later arrivals — otherwise a merge's downstream node
  // would appear to be "visited" multiple times, once per premature
  // re-descent from each of the merge's own incoming edges, and incorrectly
  // trip its own cap of 1.
  const visitCount = new Map<string, number>([[triggerId, 1]]);
  const queue = [triggerId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of outEdges.get(cur) ?? []) {
      const cap = nodesById.get(e.to)?.type === 'merge' ? (inDegree.get(e.to) ?? 0) : 1;
      const isFirstVisit = !visitCount.has(e.to);
      const nextCount = (visitCount.get(e.to) ?? 0) + 1;
      if (nextCount > cap) throw new Error(`Cycle detected — node "${e.to}" is reached more than expected`);
      visitCount.set(e.to, nextCount);
      if (isFirstVisit) queue.push(e.to);
    }
  }
  if (visitCount.size !== nodes.length) {
    const orphans = nodes.filter((n) => !visitCount.has(n.id)).map((n) => n.id);
    throw new Error(`Node(s) unreachable from the trigger: ${orphans.join(', ')}`);
  }
}

/** Runs after assertValidFlowShape()'s own checks pass — confirms the
 * NARROWER shape Parallel + Merge actually supports in v1: every branch from
 * one fork point (a node with >1 outgoing edges on the same port — a
 * trigger's own untagged edges, a condition's 'true' or 'false' port, an
 * action's 'success' or 'failure' port, each independently) must lead to the
 * SAME merge node via a simple, deterministic linear chain — no delay node,
 * no branching or further forking of any kind along the way (both break
 * static convergence-checking the same way, since neither can be resolved
 * without running the flow). v1 deliberately doesn't support a general DAG —
 * this mirrors how Loop/Approval/Sub-workflow were sequenced as later, bigger
 * work rather than solving the fully general case up front. */
function assertValidForkMergeShape(nodes: IFlowNode[], edges: IFlowEdge[]): void {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, IFlowEdge[]>();
  const inDegree = new Map<string, number>();
  for (const e of edges) {
    outEdges.set(e.from, [...(outEdges.get(e.from) ?? []), e]);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const mergeTally = new Map<string, number>();

  for (const n of nodes) {
    const outs = outEdges.get(n.id) ?? [];
    const byPort = new Map<string | undefined, IFlowEdge[]>();
    for (const e of outs) byPort.set(e.fromPort, [...(byPort.get(e.fromPort) ?? []), e]);

    for (const group of byPort.values()) {
      if (group.length <= 1) continue; // not a fork — nothing to validate here

      let mergeTarget: string | undefined;
      for (const edge of group) {
        let cur = edge.to;
        for (;;) {
          const node = nodesById.get(cur);
          if (!node) throw new Error(`Node "${n.id}"'s parallel branch leads to an unknown node "${cur}"`);
          if (node.type === 'merge') {
            if (mergeTarget === undefined) mergeTarget = node.id;
            else if (mergeTarget !== node.id) {
              throw new Error(`Node "${n.id}"'s parallel branches converge on different merge nodes ("${mergeTarget}" vs "${node.id}") — every branch from one fork must lead to the same merge node`);
            }
            mergeTally.set(node.id, (mergeTally.get(node.id) ?? 0) + 1);
            break;
          }
          if (node.type === 'delay') {
            throw new Error(`Node "${n.id}"'s parallel branch passes through a delay node ("${node.id}") — delay isn't supported inside a parallel branch yet`);
          }
          if (node.type === 'subFlow') {
            throw new Error(`Node "${n.id}"'s parallel branch passes through a subFlow node ("${node.id}") — Sub-Flow isn't supported inside a parallel branch yet`);
          }
          if (node.type === 'loop') {
            throw new Error(`Node "${n.id}"'s parallel branch passes through a loop node ("${node.id}") — Loop isn't supported inside a parallel branch yet`);
          }
          if (node.type === 'approval') {
            throw new Error(`Node "${n.id}"'s parallel branch passes through an approval node ("${node.id}") — Approval isn't supported inside a parallel branch yet`);
          }
          const nodeOuts = outEdges.get(cur) ?? [];
          if (nodeOuts.length > 1) {
            throw new Error(`Node "${n.id}"'s parallel branch passes through another branch/fork point ("${cur}") — nested branching isn't supported inside a parallel branch yet`);
          }
          if (nodeOuts.length === 0) {
            throw new Error(`Node "${n.id}"'s parallel branch ("${cur}") never reaches a merge node`);
          }
          cur = nodeOuts[0].to;
        }
      }
    }
  }

  for (const n of nodes) {
    if (n.type !== 'merge') continue;
    const expected = inDegree.get(n.id) ?? 0;
    const actual = mergeTally.get(n.id) ?? 0;
    if (actual !== expected) {
      throw new Error(`Merge node "${n.id}" has an incoming edge that doesn't originate from a validated fork point`);
    }
  }
}

/* ── Node-level field validation (mirrors automation-rule.service.ts's
   assertValidRule/assertValidTriggerField/assertValidLinkedRecordRule,
   reimplemented small rather than exported — these are message-formatting
   helpers, not shared execution state) ────────────────────────────────── */

async function assertValidNodes(tenantId: string, nodes: IFlowNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.type === 'trigger') {
      if (!node.module) throw new Error('Trigger node is missing its module');
      if ((node.triggerType ?? 'status_changed') === 'status_changed') {
        if (!(await isValidStageKey(tenantId, node.module as PipelineModule, String(node.triggerStage)))) {
          throw new Error(`"${node.triggerStage}" is not a valid stage for this tenant's ${node.module} pipeline`);
        }
      }
      if (node.triggerType === 'record_updated') {
        const catalog = await getFieldCatalog(tenantId, node.module as PipelineModule);
        if (!catalog.some((f) => f.key === node.triggerField)) {
          throw new Error(`"${node.triggerField}" is not a field on ${node.module}`);
        }
      }
    } else if (node.actionType === 'create_linked_record') {
      if (!node.targetModule) throw new Error(`Node "${node.id}": targetModule is required for create_linked_record`);
      if (!node.fieldMappings || node.fieldMappings.length === 0) {
        throw new Error(`Node "${node.id}": at least one field mapping is required for create_linked_record`);
      }
      const catalog = await getFieldCatalog(tenantId, node.targetModule as PipelineModule);
      for (const m of node.fieldMappings) {
        if (!catalog.some((f) => f.key === m.targetField)) {
          throw new Error(`Node "${node.id}": "${m.targetField}" is not a field on ${node.targetModule}`);
        }
      }
    }
    // Retry only makes sense where there's an action (or a Loop's own
    // per-item retry) to retry — the Zod schema already rejects this at the
    // API layer, but assertValidNodes is also called for direct
    // service-layer use, so it's re-checked here too.
    if (node.type !== 'action' && node.type !== 'loop' && (node.retryCount !== undefined || node.retryBackoffMs !== undefined)) {
      throw new Error(`Node "${node.id}": retryCount/retryBackoffMs are only valid on action or loop nodes`);
    }
    // Same reasoning for Delay's own field.
    if (node.type === 'delay' && node.delayMinutes === undefined) {
      throw new Error(`Node "${node.id}": delay node requires delayMinutes`);
    }
    if (node.type !== 'delay' && node.delayMinutes !== undefined) {
      throw new Error(`Node "${node.id}": delayMinutes is only valid on delay nodes`);
    }
    // Same reasoning for Loop's own required fields.
    if (node.type === 'loop') {
      if (!node.loopSourceModule) throw new Error(`Node "${node.id}": loop node requires loopSourceModule`);
      if (!node.loopSubFlowId) throw new Error(`Node "${node.id}": loop node requires loopSubFlowId`);
      if (node.loopMaxItems === undefined) throw new Error(`Node "${node.id}": loop node requires loopMaxItems`);
      if (node.loopBatchSize === undefined) throw new Error(`Node "${node.id}": loop node requires loopBatchSize`);
      if (node.loopConcurrency === undefined) throw new Error(`Node "${node.id}": loop node requires loopConcurrency`);
    }
  }
}

/** Enforces the strict two-tier Sub-Flow hierarchy: a flow is either a
 * "caller" (may contain subFlow/loop nodes, both of which invoke another
 * flow as a callee) or a "callee" (may be referenced as a Sub-Flow/Loop
 * target) — never both. This makes cross-flow cycles and unbounded nesting
 * structurally impossible, not just depth-capped — see this file's
 * top-of-model-file comment for the full rationale.
 *
 * Forward check: every subFlow node's targetFlowId, and every loop node's
 * loopSubFlowId, must reference a real, same-tenant flow that itself
 * contains no subFlow/loop/delay/approval node (a callee can't itself
 * call/loop/pause/wait-on-a-decision — see the model file's comment on why
 * delay/approval's own pause mechanism can't represent a node living in a
 * different flow document than `run.flowId`).
 *
 * Reverse check (selfId only set on updateFlow — a brand-new flow can't
 * already be referenced by anything, since nothing can know its _id yet):
 * if THIS flow (being saved) contains a subFlow/loop/delay/approval node, it
 * must NOT already be referenced as some OTHER flow's Sub-Flow/Loop target. */
async function assertValidSubFlowHierarchy(tenantId: string, nodes: IFlowNode[], selfId?: string): Promise<void> {
  const tid = new mongoose.Types.ObjectId(tenantId);

  for (const node of nodes) {
    const calledFlowId = node.type === 'subFlow' ? node.targetFlowId : node.type === 'loop' ? node.loopSubFlowId : undefined;
    if (!calledFlowId) continue;
    const target = await AutomationFlow.findOne({ _id: calledFlowId, tenantId: tid }).lean();
    if (!target) throw new Error(`Node "${node.id}": ${node.type === 'loop' ? 'loopSubFlowId' : 'targetFlowId'} "${calledFlowId}" does not exist`);
    const targetHasRestrictedNode = (target.nodes ?? []).some((n) => n.type === 'subFlow' || n.type === 'loop' || n.type === 'delay' || n.type === 'approval');
    if (targetHasRestrictedNode) {
      throw new Error(`Node "${node.id}": the target flow "${target.name}" can't be used as a Sub-Flow — it contains a subFlow/loop/delay/approval node of its own, and a callee can't itself call, loop, pause, or wait on a decision`);
    }
  }

  const hasRestrictedNodeHere = nodes.some((n) => n.type === 'subFlow' || n.type === 'loop' || n.type === 'delay' || n.type === 'approval');
  if (hasRestrictedNodeHere && selfId) {
    const referrer = await AutomationFlow.findOne({
      tenantId: tid,
      $or: [{ 'nodes.targetFlowId': selfId }, { 'nodes.loopSubFlowId': selfId }],
    }).lean();
    if (referrer) {
      throw new Error(`This flow is used as a Sub-Flow by "${referrer.name}" — a flow can't both contain a subFlow/loop/delay/approval node AND be referenced as someone else's Sub-Flow. Remove the reference in "${referrer.name}" first.`);
    }
  }
}

/* ── CRUD ──────────────────────────────────────────────────────────────── */

export async function listFlows(tenantId: string) {
  return AutomationFlow.find({ tenantId: new mongoose.Types.ObjectId(tenantId) }).sort({ createdAt: -1 }).lean();
}

export async function getFlowById(tenantId: string, id: string) {
  return AutomationFlow.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), _id: id }).lean();
}

export async function createFlow(tenantId: string, data: Partial<IAutomationFlow>) {
  assertValidFlowShape(data.nodes ?? [], data.edges ?? []);
  assertValidForkMergeShape(data.nodes ?? [], data.edges ?? []);
  await assertValidNodes(tenantId, data.nodes ?? []);
  await assertValidSubFlowHierarchy(tenantId, data.nodes ?? []);
  const triggerNode = (data.nodes ?? []).find((n) => n.type === 'trigger');
  if (triggerNode?.triggerType === 'webhook') {
    triggerNode.webhookToken = await generateWebhookToken((t) => AutomationFlow.exists({ 'nodes.webhookToken': t }).then(Boolean));
  }
  return AutomationFlow.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId) });
}

export async function updateFlow(tenantId: string, id: string, data: Partial<IAutomationFlow>) {
  if (data.nodes) {
    assertValidFlowShape(data.nodes, data.edges ?? []);
    assertValidForkMergeShape(data.nodes, data.edges ?? []);
    await assertValidNodes(tenantId, data.nodes);
    await assertValidSubFlowHierarchy(tenantId, data.nodes, id);
  }
  const tid = new mongoose.Types.ObjectId(tenantId);

  // updateFlow replaces the ENTIRE nodes[] array on every save (the natural
  // round-trip shape of a node-graph editor) — Zod strips webhookToken from
  // every incoming node regardless, so a webhook-triggered flow's trigger
  // node NEVER arrives with a token attached, on ANY save, even one editing a
  // completely unrelated node. Without this, editing anything at all on an
  // already-webhook flow would silently mint a fresh token and break an
  // already-configured external system (Stripe, a website form) on every
  // single save. Reuse the CURRENTLY STORED token if the flow's trigger node
  // is ALREADY a webhook trigger with one; mint fresh only when genuinely
  // switching into 'webhook' from something else (or none was ever issued).
  if (data.nodes) {
    const incomingTrigger = data.nodes.find((n) => n.type === 'trigger');
    if (incomingTrigger?.triggerType === 'webhook') {
      const existing = await AutomationFlow.findOne({ _id: id, tenantId: tid }).lean();
      const existingTrigger = existing?.nodes?.find((n) => n.type === 'trigger');
      if (existingTrigger?.triggerType === 'webhook' && existingTrigger.webhookToken) {
        incomingTrigger.webhookToken = existingTrigger.webhookToken;
      } else {
        incomingTrigger.webhookToken = await generateWebhookToken((t) => AutomationFlow.exists({ 'nodes.webhookToken': t }).then(Boolean));
      }
    }
  }

  return AutomationFlow.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: data }, { new: true });
}

export async function deleteFlow(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  // Sub-Flow introduced the first cross-flow reference — fail loud here
  // rather than letting a referencing flow's Sub-Flow node silently start
  // pointing at nothing (matching this project's established preference for
  // failing at save/delete time over failing silently at run time).
  const referrer = await AutomationFlow.findOne({
    tenantId: tid,
    $or: [{ 'nodes.targetFlowId': id }, { 'nodes.loopSubFlowId': id }],
  }).lean();
  if (referrer) {
    throw new Error(`This flow is used as a Sub-Flow by "${referrer.name}" — remove that reference before deleting`);
  }
  return AutomationFlow.findOneAndDelete({ _id: id, tenantId: tid });
}

/* ── Execution history reads (step 4) — read-only, runs are only ever
   created by executeFlow() itself, never via the API. ────────────────── */

export async function listFlowRuns(tenantId: string, opts: { flowId?: string; status?: string; page?: number; limit?: number } = {}) {
  const page  = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, opts.limit ?? 20);
  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  if (opts.flowId) filter.flowId = opts.flowId;
  if (opts.status) filter.status = opts.status;

  const [items, total] = await Promise.all([
    AutomationFlowRun.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AutomationFlowRun.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getFlowRunById(tenantId: string, id: string) {
  return AutomationFlowRun.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), _id: id }).lean();
}

/* ── Condition evaluation (step 2) ────────────────────────────────────────
   Reuses readSourceField() (same convention as every field mapping in this
   engine) to pull the actual value off the current record, then applies one
   of the operators from the spec doc this was built from. String comparison
   for the text operators is case-insensitive (contains/startsWith/endsWith)
   since that matches how a non-technical user reads "contains" — an exact-
   case `=`/`!=` is available separately for anyone who needs it strict. */

function toComparableNumber(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : parseFloat(String(v));
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === '';
}

/** Resolves a condition's configured value/value2 via resolveComparableValue
 * (shared with Schedule Trigger's Mongo-filter translator — see
 * automation-rule.service.ts — so 'today'/an ISO date string behave
 * identically here as they do in a schedule filter) into millis-or-number,
 * then compares against `actual` on the SAME footing (a real Date field on
 * the record correctly compares against a date-shaped threshold via
 * toComparableNumber's own Date handling above). Falls back to plain numeric
 * parsing for anything that isn't date-shaped — existing numeric conditions
 * (`expectedRevenue > 50000`) are completely unaffected. */
function resolveThreshold(raw: string | undefined): number {
  const v = resolveComparableValue(raw);
  return v instanceof Date ? v.getTime() : v;
}

function evaluateOneCondition(record: Record<string, any>, cond: IFlowCondition): boolean {
  const actual = readSourceField(record, cond.field);
  switch (cond.operator) {
    case '=':  return String(actual ?? '') === String(cond.value ?? '');
    case '!=': return String(actual ?? '') !== String(cond.value ?? '');
    case '>':  return toComparableNumber(actual) > resolveThreshold(cond.value);
    case '<':  return toComparableNumber(actual) < resolveThreshold(cond.value);
    case '>=': return toComparableNumber(actual) >= resolveThreshold(cond.value);
    case '<=': return toComparableNumber(actual) <= resolveThreshold(cond.value);
    case 'contains':   return String(actual ?? '').toLowerCase().includes(String(cond.value ?? '').toLowerCase());
    case 'startsWith': return String(actual ?? '').toLowerCase().startsWith(String(cond.value ?? '').toLowerCase());
    case 'endsWith':   return String(actual ?? '').toLowerCase().endsWith(String(cond.value ?? '').toLowerCase());
    case 'is_empty':     return isEmptyValue(actual);
    case 'is_not_empty': return !isEmptyValue(actual);
    case 'between':    return toComparableNumber(actual) >= resolveThreshold(cond.value) && toComparableNumber(actual) <= resolveThreshold(cond.value2);
    case 'in_list':     return (cond.value ?? '').split(',').map((s) => s.trim()).includes(String(actual ?? ''));
    case 'not_in_list': return !(cond.value ?? '').split(',').map((s) => s.trim()).includes(String(actual ?? ''));
    default: return false;
  }
}

/** AND-combines every condition on the node (see IFlowCondition's own
 * comment — no OR/grouping in v1). An empty conditions array (shouldn't
 * happen, Zod requires at least one) evaluates true rather than throwing,
 * so a malformed node fails safe toward "continue" not toward a crash. */
function evaluateConditionNode(record: Record<string, any>, node: IFlowNode): boolean {
  return (node.conditions ?? []).every((c) => evaluateOneCondition(record, c));
}

/* ── Execution history (step 4) ───────────────────────────────────────────
   One AutomationFlowRun document per firing, with a per-node step log —
   this is what makes a flow's behavior actually inspectable after the fact
   instead of only visible via scattered email_log entries. Steps are
   appended as they happen (not batched at the end) — deliberately, since
   build-order step 5 (delay) will need a run to sit at 'running' for real
   time between steps, and incremental writes are what makes that work
   later without another persistence-timing redesign. */

function describeNodeForLog(node: IFlowNode): string {
  if (node.type === 'trigger') return `Trigger: ${node.module} ${node.triggerType ?? 'status_changed'}`;
  if (node.type === 'condition') {
    return `Condition: ${(node.conditions ?? []).map((c) => `${c.field} ${c.operator} ${c.value ?? ''}`.trim()).join(' AND ')}`;
  }
  if (node.type === 'delay') return `Delay: ${node.delayMinutes} minute(s)`;
  if (node.type === 'merge') return 'Merge';
  if (node.type === 'subFlow') return `Sub-Flow: ${node.targetFlowId}`;
  if (node.type === 'loop') return `Loop: ${node.loopSourceModule}`;
  if (node.type === 'approval') return `Approval: ${node.approvalRecipientStrategy ?? 'manager'}`;
  if (node.actionType === 'create_linked_record') return `Create ${node.targetModule} record`;
  if (node.actionType === 'send_email') return 'Send Email';
  if (node.actionType === 'send_whatsapp') return 'Send WhatsApp';
  return 'Send SMS';
}

/** Loop's own iteration-source query — mirrors queryScheduleMatches's exact
 * shape (stable `_id` ascending sort, tenant-scoped, capped by `limit`) but
 * dispatches over LoopSourceModule (PipelineModule + 'customer') instead of
 * the closed PipelineModule union, since NativeCustomer isn't part of that
 * union (see LoopSourceModule's own comment in automation-flow.model.ts).
 * Delegates back to queryScheduleMatches for every module it already
 * supports, so the "which Mongoose model" mapping stays in exactly one
 * place for everything except the one extra case this function adds. */
async function queryLoopItems(
  tenantId: string, module: LoopSourceModule, filter: Record<string, any>, limit: number,
): Promise<Record<string, any>[]> {
  if (module === 'customer') {
    const { NativeCustomer } = await import('../customers/customer.model');
    const tid = new mongoose.Types.ObjectId(tenantId);
    return NativeCustomer.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean();
  }
  return queryScheduleMatches(tenantId, module, filter, limit);
}

async function logStep(runId: mongoose.Types.ObjectId, step: IFlowRunStep): Promise<void> {
  await AutomationFlowRun.updateOne({ _id: runId }, { $push: { steps: step } }).catch((err) =>
    logger.error('Failed to log flow run step', { runId, error: (err as Error).message }));
}

type NodeCtx = { currentRecord: Record<string, any>; currentModule: PipelineModule; hadSkip: boolean };

type ProcessResult =
  | { kind: 'advance'; ctx: NodeCtx; nextIds: string[] } // nextIds.length: 0 = dead end, 1 = normal, >1 = fork
  | { kind: 'paused'; ctx: NodeCtx }
  | { kind: 'hard-fail'; ctx: NodeCtx };

/** Invokes a target flow inline — the shared mechanism behind BOTH a plain
 * `subFlow` node (called once) and a `loop` node's own body (called once per
 * matching item). Looks up the target fresh on every call — for Loop this
 * means one extra small read per iteration, deliberately: correctness over a
 * micro-optimization, and the callee's own action(s) already dominate the
 * per-item cost. Reuses runLoop's inline-invocation mode (see its own doc
 * comment) so the callee's steps land in the SAME run document, tagged via
 * `tag`. An inline invocation can never legitimately pause (the two-tier
 * hierarchy guarantees the callee has no delay/approval/subFlow/loop node of
 * its own) — runLoop's own inlineOpts handling already collapses that case
 * to 'failed' internally, so `status` here is always 'completed'/'partial'/
 * 'failed' in practice, despite the wider declared type. */
async function invokeFlowInline(
  tenantId: string,
  targetFlowId: string,
  runId: mongoose.Types.ObjectId,
  itemRecord: Record<string, any>,
  itemModule: PipelineModule,
  depth: number,
  toStage: string,
  tag: { subFlowNodeId: string; loopIterationIndex?: number },
): Promise<{ status: 'completed' | 'partial' | 'failed'; targetFlowName: string }> {
  const targetFlow = await AutomationFlow.findOne({ _id: targetFlowId, tenantId: new mongoose.Types.ObjectId(tenantId) });
  if (!targetFlow || !targetFlow.enabled) {
    logger.error('Sub-Flow/Loop target missing or disabled', { targetFlowId });
    return { status: 'failed', targetFlowName: '(missing)' };
  }
  const targetTrigger = targetFlow.nodes.find((n) => n.type === 'trigger');
  const subStartCursors = targetTrigger ? targetFlow.edges.filter((e) => e.from === targetTrigger.id).map((e) => e.to) : [];
  const result = await runLoop(
    tenantId, targetFlow, runId, new Date(), subStartCursors,
    { currentRecord: itemRecord, currentModule: itemModule, depth, hadSkip: false, toStage },
    targetTrigger?.id ?? 'start',
    tag,
  );
  const status = result.status === 'paused' ? 'failed' : result.status;
  return { status, targetFlowName: targetFlow.name };
}

/** Processes exactly ONE node and reports what should happen next — the
 * per-node executor shared by runLoop's own main walk (the non-forking case)
 * and runBranch's per-branch walk (inside a parallel fork). Only ever called
 * with an 'action'/'condition'/'delay' node — merge nodes are handled
 * entirely by the fork-orchestration in runLoop/runBranch, never dispatched
 * here. Crucially, this function NEVER finalizes the run (no finish() call)
 * — a hard failure here just reports {kind:'hard-fail'}; only runLoop's
 * outer loop (non-fork path) and the fork-orchestrator (after every branch
 * has settled) are allowed to actually finalize the run, since calling
 * finish() from inside one branch while siblings are still executing would
 * finalize a run document that isn't actually done yet. `branchTag`, when
 * set, tags every logged step with `forkId`/`branchIndex` so a flat,
 * execution-order-interleaved steps[] array can be regrouped into per-branch
 * timelines later — absent for the ordinary non-parallel case, so every
 * existing flow's step log stays byte-identical to before this feature. */
async function processOneNode(
  tenantId: string,
  flow: IAutomationFlow,
  runId: mongoose.Types.ObjectId,
  node: IFlowNode,
  ctx: NodeCtx,
  depth: number,
  toStage: string,
  branchTag?: { forkId: string; branchIndex: number },
  subFlowNodeId?: string,
  loopIterationIndex?: number,
): Promise<ProcessResult> {
  let { currentRecord, currentModule, hadSkip } = ctx;
  const stepStart = new Date();
  const log = (step: IFlowRunStep) => logStep(runId, {
    ...step,
    ...(branchTag ? { forkId: branchTag.forkId, branchIndex: branchTag.branchIndex } : {}),
    ...(subFlowNodeId ? { subFlowNodeId } : {}),
    ...(loopIterationIndex !== undefined ? { loopIterationIndex } : {}),
  });

  if (node.type === 'delay') {
    // Pauses the run entirely — this invocation ends here; pollPausedFlows()/
    // resumeFlow() drive a LATER, separate invocation that continues from
    // exactly this snapshot. currentRecord is a full point-in-time snapshot,
    // not a live re-fetch-by-id (see the model file's own comment on why) —
    // a node after the delay acts on the record's state as of the pause, not
    // whatever it's changed to since. Delay never forks (see
    // assertValidFlowShape's own comment) so this is always reached with a
    // single incoming path, never from inside a still-unresolved branch.
    const resumeAt = new Date(Date.now() + (node.delayMinutes ?? 0) * 60_000);
    const nextCursor = flow.edges.find((e) => e.from === node.id)?.to;
    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'delay', label: describeNodeForLog(node),
      status: 'success', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      result: `paused until ${resumeAt.toISOString()}`,
    });
    await AutomationFlowRun.updateOne({ _id: runId }, {
      $set: {
        status: 'paused', resumeAt,
        pauseState: { cursor: nextCursor, currentRecord, currentModule, depth, hadSkip, toStage },
      },
    }).catch((err) => logger.error('Failed to pause flow run', { runId, error: (err as Error).message }));
    return { kind: 'paused', ctx: { currentRecord, currentModule, hadSkip } };
  }

  if (node.type === 'condition') {
    const result = evaluateConditionNode(currentRecord, node);
    const port = result ? 'true' : 'false';
    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'condition', label: describeNodeForLog(node),
      status: 'success', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      result: String(result),
    });
    await writeLog({
      tenantId, channel: 'system', kind: 'automation', sourceModule: currentModule,
      sourceId: String(currentRecord._id ?? currentRecord.recordId ?? ''),
      status: 'sent', bodyPreview: `Flow "${flow.name}" node "${node.id}" evaluated to ${result} — following the ${port} branch`,
    }).catch(() => {});
    const nextIds = flow.edges.filter((e) => e.from === node.id && e.fromPort === port).map((e) => e.to);
    return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip }, nextIds };
  }

  if (node.type === 'subFlow') {
    // Inline invocation — runs the callee's own nodes as part of THIS SAME
    // run document (tagged with subFlowNodeId, not a separate
    // AutomationFlowRun), using the CALLER's current record as the callee's
    // starting context (the callee runs against whatever record the caller
    // currently has in hand). The two-tier hierarchy
    // (assertValidSubFlowHierarchy) guarantees the callee contains no
    // subFlow/loop/delay/approval node, so this can never itself pause or
    // nest further.
    const subResult = await invokeFlowInline(
      tenantId, node.targetFlowId!, runId, currentRecord, currentModule, depth, toStage,
      { subFlowNodeId: node.id },
    );
    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'subFlow', label: describeNodeForLog(node),
      status: subResult.status === 'failed' ? 'failed' : 'success',
      startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      result: `Sub-Flow "${subResult.targetFlowName}" ${subResult.status}`,
    });
    if (subResult.status === 'failed') {
      return { kind: 'hard-fail', ctx: { currentRecord, currentModule, hadSkip } };
    }
    // Reverts to the pre-call record/module — same deliberate simplification
    // already confirmed for Parallel + Merge's post-merge behavior; the
    // callee's own side effects (e.g. a create_linked_record inside it)
    // don't automatically become "the record" for whatever comes after this
    // Sub-Flow node in the caller.
    const nextIds = flow.edges.filter((e) => e.from === node.id).map((e) => e.to);
    return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip: hadSkip || subResult.status === 'partial' }, nextIds };
  }

  if (node.type === 'loop') {
    // Fully synchronous within this one call — no pause/resume, no new cron
    // job (see this file's/the plan's own reasoning: reusing pollPausedFlows'
    // 2-minute cadence for INTER-BATCH continuation would make a large loop
    // take tens of minutes just from poll overhead; loopMaxItems exists
    // precisely so the whole thing can safely run to completion in one call).
    const loopModule = node.loopSourceModule as LoopSourceModule;
    const maxItems = node.loopMaxItems ?? 0;
    const batchSize = node.loopBatchSize ?? maxItems;
    const concurrency = node.loopConcurrency ?? 1;
    const loopRetryCount = node.retryCount ?? 0;
    const loopRetryBackoffMs = node.retryBackoffMs ?? 0;

    const filter = conditionsToMongoFilter(node.loopFilter);
    const probe = await queryLoopItems(tenantId, loopModule, filter, maxItems + 1);
    const hasMore = probe.length > maxItems;
    const items = probe.slice(0, maxItems);
    if (hasMore) {
      logger.error('Loop match cap reached — remainder not processed this run', { flowId: flow._id, nodeId: node.id, module: loopModule, matched: probe.length, cap: maxItems });
    }

    let loopHadSkip = false;
    let loopHardFailed = false;
    let processedCount = 0;

    for (let pageStart = 0; pageStart < items.length && !loopHardFailed; pageStart += batchSize) {
      const page = items.slice(pageStart, pageStart + batchSize);
      for (let chunkStart = 0; chunkStart < page.length && !loopHardFailed; chunkStart += concurrency) {
        const chunk = page.slice(chunkStart, chunkStart + concurrency);
        const results = await Promise.allSettled(chunk.map(async (item, i) => {
          const iterationIndex = pageStart + chunkStart + i;
          let lastStatus: 'completed' | 'partial' | 'failed' = 'failed';
          for (let attempt = 1; attempt <= loopRetryCount + 1; attempt++) {
            const attemptResult = await invokeFlowInline(
              tenantId, node.loopSubFlowId!, runId, item, loopModule as PipelineModule, depth, toStage,
              { subFlowNodeId: node.id, loopIterationIndex: iterationIndex },
            );
            lastStatus = attemptResult.status;
            if (lastStatus !== 'failed') break;
            if (attempt <= loopRetryCount && loopRetryBackoffMs > 0) await new Promise((r) => setTimeout(r, loopRetryBackoffMs));
          }
          return lastStatus;
        }));
        for (const r of results) {
          if (r.status === 'rejected') { loopHardFailed = true; continue; }
          if (r.value === 'failed') loopHadSkip = true; // a Loop's own iteration failure is soft — see this node's own doc comment on why
          if (r.value === 'partial') loopHadSkip = true;
          processedCount++;
        }
      }
    }

    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'loop', label: describeNodeForLog(node),
      status: 'success', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      result: `processed ${processedCount}/${items.length} item(s)${hasMore ? ` (capped at ${maxItems}, ${probe.length - maxItems}+ more matched but not processed)` : ''}`,
    });

    // Reverts to the pre-loop record/module, same as Sub-Flow/Parallel+Merge.
    const nextIds = flow.edges.filter((e) => e.from === node.id).map((e) => e.to);
    return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip: hadSkip || loopHadSkip }, nextIds };
  }

  if (node.type === 'approval') {
    // Pauses the run for a human decision — reuses Delay's exact
    // pauseState/status:'paused' shape, but resumes via an explicit
    // decideApproval() call (Approve/Reject), never a timer. resumeAt is
    // deliberately left unset so pollPausedFlows()'s existing
    // {status:'paused', resumeAt:{$lte:now}} query naturally never matches
    // this pause. A failed/unresolvable notification is not a reason to
    // skip the gate itself — the run pauses regardless, same "soft-skip,
    // don't block" posture a send_* node's own missing-recipient case
    // already has, just without a failure-edge escape hatch (approval has
    // no such edge — every path here leads to the same pause).
    const recipient = await resolveAutomationRecipient(tenantId, currentModule, currentRecord, node.approvalRecipientStrategy ?? 'manager');
    let notifyResult = 'skipped: no resolvable recipient';
    if (recipient?.email) {
      const variables = buildVariables(currentRecord, recipient.name, toStage);
      const subject = `Approval needed: ${variables.title || variables.id}`;
      const body = `<p>A ${currentModule} record (${variables.title || variables.id}) is waiting on your approval.</p>`;
      const messageId = await sendEmailNow({ to: recipient.email, toName: recipient.name, subject, htmlContent: body });
      notifyResult = messageId ? `notified ${recipient.email}` : 'email channel not configured';
      if (messageId) {
        await writeLog({
          tenantId, channel: 'email', kind: 'automation', sourceModule: currentModule,
          sourceId: String(currentRecord._id ?? currentRecord.recordId ?? ''),
          recipientName: recipient.name, recipientEmail: recipient.email, subject,
          bodyPreview: body.replace(/<[^>]+>/g, ' '), status: 'sent', providerMessageId: messageId ?? undefined,
        });
      }
    }
    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'approval', label: describeNodeForLog(node),
      status: 'success', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      result: `paused for approval (${notifyResult})`,
    });
    await AutomationFlowRun.updateOne({ _id: runId }, {
      $set: {
        status: 'paused',
        pauseState: { currentRecord, currentModule, depth, hadSkip, toStage, kind: 'approval', pausedNodeId: node.id },
      },
    }).catch((err) => logger.error('Failed to pause flow run for approval', { runId, error: (err as Error).message }));
    return { kind: 'paused', ctx: { currentRecord, currentModule, hadSkip } };
  }

  const sourceId = String(currentRecord._id ?? currentRecord.recordId ?? '');
  // Retry: retryCount is "retries AFTER the first attempt" (0/absent ==
  // today's pre-Retry behavior — fail/skip on the very first try, no
  // wait). Only stamp `attempt` on logged steps when retry is actually
  // configured, so a plain (never-retried) node's step log looks exactly
  // as it did before Retry existed. Only the CORE action call below is
  // ever retried — bookkeeping that runs after a successful attempt
  // (audit log, cascading triggers, currentRecord/currentModule update)
  // runs exactly once and is never repeated, even if it itself throws —
  // repeating it would risk creating a second linked record or resending
  // an already-sent message for what should be one logical success.
  const maxAttempts = (node.retryCount ?? 0) + 1;
  const backoffMs = node.retryBackoffMs ?? 0;
  const stampAttempt = maxAttempts > 1;

  // Error Branch: if this node has 'failure'-tagged edges (possibly more
  // than one, as of Parallel + Merge — a fork on the failure port), an
  // exhausted failure follows ALL of them instead of the fixed hard-stop/
  // soft-skip below — `outcome` tracks which of the two the shared cursor
  // lookup at the bottom of this function should use. Defaults to 'success'
  // since most exits from this block (including every early return after
  // taking the failure edge(s) directly) never touch the shared lookup at
  // all; it's only flipped to 'failure' for the one fallback case that DOES
  // still reach the shared lookup — a send_* that failed with no failure
  // edge configured, which must never accidentally take a 'success' edge.
  const failureIds = () => flow.edges.filter((e) => e.from === node.id && e.fromPort === 'failure').map((e) => e.to);
  let outcome: 'success' | 'failure' = 'success';

  // This outer try/catch is NOT what implements Retry (the two retry loops
  // below handle their own core-call failures internally and never let them
  // propagate this far) — it's the same safety net the engine had before
  // Retry existed, now covering template lookup, recipient resolution, and
  // post-success bookkeeping (anything outside the retry loops), so an
  // unexpected throw there still ends this node's processing with a clean
  // hard-fail instead of leaving the run orphaned at 'running' forever.
  try {
  if (node.actionType === 'create_linked_record') {
    const payload: Record<string, unknown> = {};
    for (const m of node.fieldMappings ?? []) {
      const value = m.sourceType === 'static' ? m.staticValue : readSourceField(currentRecord, m.sourceField!);
      setPayloadField(payload, m.targetField, value);
    }
    if (node.backReferenceField) {
      setPayloadField(payload, node.backReferenceField, sourceIdentifierOf(currentRecord));
    }

    let created: Record<string, any> | undefined;
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = new Date();
      try {
        created = await createRecordInTargetModule(tenantId, node.targetModule!, payload, depth + 1);
        break;
      } catch (err) {
        lastError = (err as Error).message;
        const finishedAt = new Date();
        await log({
          nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node),
          status: 'failed', startedAt: attemptStart, finishedAt, durationMs: finishedAt.getTime() - attemptStart.getTime(),
          error: lastError, ...(stampAttempt ? { attempt } : {}),
        });
        if (attempt < maxAttempts) {
          if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    if (!created) {
      // Retries exhausted (or retryCount was 0). Error Branch: if THIS node
      // has failure edge(s), follow them instead of hard-stopping — the
      // failure still genuinely happened (hadSkip=true keeps the run
      // 'partial', not a clean 'completed') even though it was handled. No
      // failure edge configured → exactly today's hard-stop, regardless of
      // whether a 'success' edge happens to exist on this node.
      logger.error('AutomationFlow node execution failed', { flowId: flow._id, nodeId: node.id, error: lastError });
      await writeLog({ tenantId, channel: 'system', kind: 'automation', sourceModule: currentModule, sourceId, status: 'failed', errorMessage: `Flow "${flow.name}" node "${node.id}": ${lastError}` }).catch(() => {});
      const failIds = failureIds();
      if (failIds.length > 0) {
        return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip: true }, nextIds: failIds };
      }
      return { kind: 'hard-fail', ctx: { currentRecord, currentModule, hadSkip } };
    }

    const successAt = new Date();
    await writeLog({
      tenantId, channel: 'system', kind: 'automation', sourceModule: currentModule, sourceId,
      status: 'sent', bodyPreview: `Flow "${flow.name}": created a ${node.targetModule} record (node "${node.id}")`,
    });
    await log({
      nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node),
      status: 'success', startedAt: stepStart, finishedAt: successAt, durationMs: successAt.getTime() - stepStart.getTime(),
      result: sourceIdentifierOf(created), createdRecordModule: node.targetModule, createdRecordId: sourceIdentifierOf(created),
    });

    // Same reasoning as automation-rule.service.ts's runCreateLinkedRecordAction:
    // built-in create*() service functions don't fire their own
    // record_created hooks (only their HTTP controllers do), so this
    // dispatcher fires them explicitly for built-in targets — Custom
    // Module targets already fired theirs inside createRecordInTargetModule.
    if (!node.targetModule!.startsWith('custom:')) {
      const { runAutomationsOnCreate } = await import('../automation-rules/automation-rule.service');
      await runAutomationsOnCreate(tenantId, node.targetModule as PipelineModule, created, depth + 1);
    }
    await runFlowsOnCreate(tenantId, node.targetModule as PipelineModule, created, depth + 1);

    currentRecord = created;
    currentModule = node.targetModule as PipelineModule;
  } else {
    const channel: 'email' | 'sms' | 'whatsapp' =
      node.actionType === 'send_email' ? 'email' : node.actionType === 'send_whatsapp' ? 'whatsapp' : 'sms';
    const template = await getTemplateById(tenantId, node.templateId!);
    if (!template) {
      // Terminal — a missing template can't fix itself mid-run, so this
      // never consumes a retry attempt, exactly as before Retry existed.
      // Error Branch: still a genuine failure of this node, so it follows
      // failure edge(s) if any exist, same as an exhausted-retry failure.
      await writeLog({ tenantId, channel, kind: 'automation', sourceModule: currentModule, sourceId, status: 'skipped', errorMessage: `Flow "${flow.name}" node "${node.id}": template not found` });
      hadSkip = true;
      const finishedAt = new Date();
      await log({ nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node), status: 'skipped', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(), result: 'skipped: template not found' });
      const failIds = failureIds();
      if (failIds.length > 0) {
        return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip }, nextIds: failIds };
      }
      outcome = 'failure';
    } else {
      const recipient = await resolveAutomationRecipient(tenantId, currentModule, currentRecord, node.recipientStrategy ?? 'record_contact');
      if (!recipient || (channel === 'email' && !recipient.email) || ((channel === 'sms' || channel === 'whatsapp') && !recipient.phone)) {
        // Terminal, same reasoning as a missing template — also eligible
        // for failure edge(s).
        await writeLog({ tenantId, channel, kind: 'automation', sourceModule: currentModule, sourceId, status: 'skipped', errorMessage: 'No resolvable recipient' });
        hadSkip = true;
        const finishedAt = new Date();
        await log({ nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node), status: 'skipped', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(), result: 'skipped: no resolvable recipient' });
        const failIds = failureIds();
        if (failIds.length > 0) {
          return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip }, nextIds: failIds };
        }
        outcome = 'failure';
      } else {
        const variables = buildVariables(currentRecord, recipient.name, toStage);
        const body = renderTemplate(template.body, variables);

        let ok = false;
        let sendResult = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptStart = new Date();
          try {
            if (node.actionType === 'send_email') {
              const subject = renderTemplate(template.subject || `Update: ${variables.title || variables.id}`, variables);
              const messageId = await sendEmailNow({ to: recipient.email!, toName: recipient.name, subject, htmlContent: body });
              ok = !!messageId;
              sendResult = ok ? `sent to ${recipient.email}` : 'email channel not configured';
              if (ok) await writeLog({ tenantId, channel: 'email', kind: 'automation', sourceModule: currentModule, sourceId, recipientName: recipient.name, recipientEmail: recipient.email, subject, bodyPreview: body.replace(/<[^>]+>/g, ' '), status: 'sent', providerMessageId: messageId ?? undefined });
            } else if (node.actionType === 'send_whatsapp') {
              const messageId = await sendWhatsAppNow(recipient.phone!, body);
              ok = !!messageId;
              sendResult = ok ? `sent to ${recipient.phone}` : 'WhatsApp not configured';
              if (ok) await writeLog({ tenantId, channel: 'whatsapp', kind: 'automation', sourceModule: currentModule, sourceId, recipientName: recipient.name, recipientPhone: recipient.phone, bodyPreview: body, status: 'sent', providerMessageId: messageId ?? undefined });
            } else {
              const sid = await sendSmsNow({ to: recipient.phone!, body });
              ok = !!sid;
              sendResult = ok ? `sent to ${recipient.phone}` : 'SMS send failed or not configured';
              if (ok) await writeLog({ tenantId, channel: 'sms', kind: 'automation', sourceModule: currentModule, sourceId, recipientName: recipient.name, recipientPhone: recipient.phone, bodyPreview: body, status: 'sent', providerMessageId: sid ?? undefined });
            }
          } catch (err) {
            ok = false;
            sendResult = (err as Error).message;
          }

          const finishedAt = new Date();
          if (ok) {
            await log({
              nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node),
              status: 'success', startedAt: attemptStart, finishedAt, durationMs: finishedAt.getTime() - attemptStart.getTime(),
              result: sendResult, variables, ...(stampAttempt ? { attempt } : {}),
            });
            break;
          }
          await log({
            nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node),
            status: 'failed', startedAt: attemptStart, finishedAt, durationMs: finishedAt.getTime() - attemptStart.getTime(),
            error: sendResult, ...(stampAttempt ? { attempt } : {}),
          });
          if (attempt < maxAttempts && backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
        }

        if (!ok) {
          // Retries exhausted (or retryCount was 0). Error Branch: if this
          // node has failure edge(s), follow them (still marks hadSkip, so
          // the run stays 'partial'); otherwise fall through to the shared
          // cursor lookup below with outcome flipped to 'failure', which
          // must find ONLY untagged edges — never a 'success' one, even if
          // this node happens to have one configured — matching today's
          // exact soft-skip-and-continue for a plain (non-branching) node,
          // and correctly dead-ending for a node that opted into branching
          // but didn't wire a failure edge.
          hadSkip = true;
          await writeLog({ tenantId, channel, kind: 'automation', sourceModule: currentModule, sourceId, status: 'failed', errorMessage: sendResult, recipientName: recipient.name, recipientEmail: channel === 'email' ? recipient.email : undefined, recipientPhone: channel !== 'email' ? recipient.phone : undefined }).catch(() => {});
          const failIds = failureIds();
          if (failIds.length > 0) {
            return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip }, nextIds: failIds };
          }
          outcome = 'failure';
        }
      }
    }
  }
  } catch (err) {
    // Reached only for something OUTSIDE the retry loops above (template
    // lookup, recipient resolution, or post-success bookkeeping throwing) —
    // the loops themselves never let a core-call failure escape this far.
    logger.error('AutomationFlow node execution failed', { flowId: flow._id, nodeId: node.id, error: (err as Error).message });
    await writeLog({ tenantId, channel: 'system', kind: 'automation', sourceModule: currentModule, sourceId, status: 'failed', errorMessage: `Flow "${flow.name}" node "${node.id}": ${(err as Error).message}` }).catch(() => {});
    const finishedAt = new Date();
    await log({
      nodeId: node.id, nodeType: 'action', label: describeNodeForLog(node),
      status: 'failed', startedAt: stepStart, finishedAt, durationMs: finishedAt.getTime() - stepStart.getTime(),
      error: (err as Error).message,
    });
    return { kind: 'hard-fail', ctx: { currentRecord, currentModule, hadSkip } };
  }

  // Reached on: create_linked_record success (outcome is always 'success'
  // here — every failure path either returned early via failure edge(s) or
  // reported hard-fail), or a send_* success/fallback-failure-with-no-edge.
  // 'success'-tagged edges are only ever matched when outcome is genuinely
  // 'success' — critical for the fallback-failure case above, where this
  // node may still have a 'success' edge configured (just no 'failure' edge)
  // and must NOT take it just because it's the only tagged edge here.
  const nextIds = flow.edges
    .filter((e) => e.from === node.id && (e.fromPort === undefined || (outcome === 'success' && e.fromPort === 'success')))
    .map((e) => e.to);
  return { kind: 'advance', ctx: { currentRecord, currentModule, hadSkip }, nextIds };
}

type BranchResult =
  | { status: 'reached-merge'; mergeId: string; ctx: NodeCtx }
  | { status: 'hard-fail' };

/** Walks ONE parallel branch, from a fork's target node to the shared merge
 * node, repeatedly calling processOneNode — validation (assertValidForkMergeShape)
 * guarantees this is a simple linear chain (no nested fork, no delay, no
 * conditional branching) so `nextIds` is always exactly length 1 here until
 * the merge node itself is reached. A delay or an unexpected pause reached
 * here would be an invariant violation, not a real runtime possibility (the
 * same validation rejects both) — defended anyway rather than silently
 * mishandled. */
async function runBranch(
  tenantId: string,
  flow: IAutomationFlow,
  runId: mongoose.Types.ObjectId,
  startId: string,
  ctx: NodeCtx,
  depth: number,
  toStage: string,
  forkId: string,
  branchIndex: number,
  subFlowNodeId?: string,
): Promise<BranchResult> {
  let localCtx = ctx;
  let id = startId;
  for (;;) {
    const node = flow.nodes.find((n) => n.id === id);
    if (!node) return { status: 'hard-fail' };
    if (node.type === 'merge') return { status: 'reached-merge', mergeId: node.id, ctx: localCtx };
    if (node.type === 'delay') {
      logger.error('Invariant violated: delay node reached inside a parallel branch', { flowId: flow._id, nodeId: node.id });
      return { status: 'hard-fail' };
    }
    if (node.type === 'subFlow') {
      logger.error('Invariant violated: subFlow node reached inside a parallel branch', { flowId: flow._id, nodeId: node.id });
      return { status: 'hard-fail' };
    }
    if (node.type === 'loop') {
      logger.error('Invariant violated: loop node reached inside a parallel branch', { flowId: flow._id, nodeId: node.id });
      return { status: 'hard-fail' };
    }
    if (node.type === 'approval') {
      logger.error('Invariant violated: approval node reached inside a parallel branch', { flowId: flow._id, nodeId: node.id });
      return { status: 'hard-fail' };
    }
    const result = await processOneNode(tenantId, flow, runId, node, localCtx, depth, toStage, { forkId, branchIndex }, subFlowNodeId);
    localCtx = result.ctx;
    if (result.kind === 'hard-fail') return { status: 'hard-fail' };
    if (result.kind === 'paused') {
      logger.error('Invariant violated: a parallel branch paused unexpectedly', { flowId: flow._id, nodeId: node.id });
      return { status: 'hard-fail' };
    }
    if (result.nextIds.length === 0) return { status: 'hard-fail' }; // dead end inside a branch — shouldn't happen, validation requires every branch to reach the merge
    id = result.nextIds[0]; // always exactly 1 — nested branching is rejected at validation time
  }
}

/** The shared engine both a fresh trigger firing (executeFlow) and a resumed
 * paused run (resumeFlow) drive — walks nodes starting at `startCursors`,
 * branching at condition nodes via the matching fromPort edge, pausing at a
 * delay node instead of continuing, and — as of Parallel + Merge — forking
 * into concurrent branches whenever a lookup produces more than one next id
 * (`cursors.length > 1`), running them via Promise.allSettled and continuing
 * from the shared merge node's own single outgoing edge once every branch
 * has settled. `currentRecord`/`currentModule` are threaded forward and
 * updated after each `create_linked_record` step to the just-created
 * record/module — so a later node's field mappings naturally read from THAT
 * record via the exact same readSourceField mechanism, unchanged (see the
 * model file's comment: this is what makes "Lead Won → Create Customer →
 * Assign Team" mean the team gets assigned to the customer just created, not
 * the original lead). A send_* node never changes currentRecord/currentModule.
 * After a Merge, currentRecord/currentModule revert to their PRE-FORK values
 * — parallel branches are independent side-effects, nothing after Merge
 * automatically inherits any one branch's created record (a deliberate
 * simplification, confirmed with the user — avoids having to pick a
 * "winner" among several branches, some of which may each create a
 * different linked record). Only hadSkip propagates out of the branches
 * (OR-accumulated into the outer hadSkip). If ANY branch hard-fails, the
 * merge's continuation never happens and the whole run finishes 'failed' —
 * a direct generalization of today's existing single-branch "hard failure
 * stops everything" rule, decided once every branch has settled (via
 * Promise.allSettled, not Promise.all, so one branch's failure never aborts
 * an in-flight sibling's own side effects). `runStartedAt` is always the
 * run's ORIGINAL start (persisted on the run doc, re-passed on resume) so a
 * run's reported `durationMs` is real wall-clock time including any pause,
 * not just processing time.
 *
 * `inlineOpts`, when set (Sub-Flow's own invocation), makes this call NEVER
 * finalize the run document itself (the caller — always the TOP-level
 * runLoop invocation for THIS run — is the only one allowed to do that) and
 * tags every step it logs with `subFlowNodeId` instead. The two-tier
 * Sub-Flow hierarchy guarantees a callee contains no delay/approval/subFlow
 * node, so an inline invocation can never legitimately pause or nest further
 * — both are defended against anyway as invariant violations, not silently
 * mishandled. Always returns the walk's outcome (`status`/`ctx`) so a
 * calling `subFlow` node can decide how to advance; the top-level caller
 * (executeFlow/resumeFlow) is free to ignore the return value. */
async function runLoop(
  tenantId: string,
  flow: IAutomationFlow,
  runId: mongoose.Types.ObjectId,
  runStartedAt: Date,
  startCursors: string[],
  initial: { currentRecord: Record<string, any>; currentModule: PipelineModule; depth: number; hadSkip: boolean; toStage: string },
  startNodeId = 'start',
  inlineOpts?: { subFlowNodeId: string; loopIterationIndex?: number },
): Promise<{ status: 'completed' | 'partial' | 'failed' | 'paused'; ctx: NodeCtx }> {
  let ctx: NodeCtx = { currentRecord: initial.currentRecord, currentModule: initial.currentModule, hadSkip: initial.hadSkip };
  const { depth, toStage } = initial;
  const subFlowNodeId = inlineOpts?.subFlowNodeId;
  const loopIterationIndex = inlineOpts?.loopIterationIndex;

  const computeStatus = (base: 'completed' | 'failed'): 'completed' | 'partial' | 'failed' =>
    base === 'completed' && ctx.hadSkip ? 'partial' : base;

  const finish = async (status: 'completed' | 'failed') => {
    if (inlineOpts) return; // an inline (Sub-Flow) invocation never finalizes the run itself
    const finishedAt = new Date();
    await AutomationFlowRun.updateOne({ _id: runId }, {
      $set: { status: computeStatus(status), finishedAt, durationMs: finishedAt.getTime() - runStartedAt.getTime() },
    }).catch((err) => logger.error('Failed to finalize flow run', { runId, error: (err as Error).message }));
  };

  let cursors: string[] = startCursors;
  let lastNodeId = startNodeId;
  while (cursors.length > 0) {
    if (cursors.length === 1) {
      const node = flow.nodes.find((n) => n.id === cursors[0]);
      if (!node || (node.type !== 'action' && node.type !== 'condition' && node.type !== 'delay' && node.type !== 'subFlow' && node.type !== 'loop' && node.type !== 'approval')) break;
      const result = await processOneNode(tenantId, flow, runId, node, ctx, depth, toStage, undefined, subFlowNodeId, loopIterationIndex);
      ctx = result.ctx;
      if (result.kind === 'paused') {
        if (inlineOpts) {
          logger.error('Invariant violated: an inline Sub-Flow invocation paused unexpectedly', { flowId: flow._id, nodeId: node.id });
          return { status: 'failed', ctx };
        }
        return { status: 'paused', ctx };
      }
      if (result.kind === 'hard-fail') { await finish('failed'); return { status: 'failed', ctx }; }
      lastNodeId = node.id;
      cursors = result.nextIds;
      continue;
    }

    // Fork — cursors.length > 1. `lastNodeId` is whichever node's edges just
    // produced this array (the trigger, on the very first iteration if it
    // fans out; otherwise whatever node was processed last).
    const forkId = lastNodeId;
    const settled = await Promise.allSettled(
      cursors.map((startId, i) => runBranch(tenantId, flow, runId, startId, ctx, depth, toStage, forkId, i, subFlowNodeId)),
    );
    const anyHardFail = settled.some((r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'hard-fail'));
    if (anyHardFail) {
      await finish('failed');
      return { status: 'failed', ctx };
    }

    const branches = settled.map((r) => (r as PromiseFulfilledResult<Extract<BranchResult, { status: 'reached-merge' }>>).value);
    const mergeId = branches[0].mergeId;
    ctx = { currentRecord: ctx.currentRecord, currentModule: ctx.currentModule, hadSkip: ctx.hadSkip || branches.some((b) => b.ctx.hadSkip) };

    const mergeNode = flow.nodes.find((n) => n.id === mergeId);
    const mergeAt = new Date();
    await logStep(runId, {
      nodeId: mergeId, nodeType: 'merge', label: mergeNode ? describeNodeForLog(mergeNode) : 'Merge',
      status: 'success', startedAt: mergeAt, finishedAt: mergeAt, durationMs: 0,
      result: `merged ${branches.length} branch(es)`,
      ...(subFlowNodeId ? { subFlowNodeId } : {}),
    });

    lastNodeId = mergeId;
    cursors = flow.edges.filter((e) => e.from === mergeId).map((e) => e.to);
  }

  await finish('completed');
  return { status: computeStatus('completed'), ctx };
}

/** Entry point for a fresh trigger firing — creates the run record, then
 * hands off to the shared runLoop() starting right after the trigger node.
 * Unchanged from the outside (same signature, same callers) even though its
 * own body shrank considerably once the loop moved into runLoop(). */
async function executeFlow(
  tenantId: string,
  flow: IAutomationFlow,
  triggerRecord: Record<string, any>,
  triggerModule: PipelineModule,
  toStage: string,
  depth: number,
): Promise<void> {
  const triggerNode = flow.nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) return;

  const startedAt = new Date();
  const run = await AutomationFlowRun.create({
    tenantId: new mongoose.Types.ObjectId(tenantId), flowId: flow._id, flowName: flow.name,
    status: 'running', triggerModule, triggerRecordId: String(triggerRecord._id ?? triggerRecord.recordId ?? ''),
    startedAt,
    steps: [{
      nodeId: triggerNode.id, nodeType: 'trigger', label: describeNodeForLog(triggerNode),
      status: 'success', startedAt, finishedAt: startedAt, durationMs: 0,
    }],
  });

  const startCursors = flow.edges.filter((e) => e.from === triggerNode.id).map((e) => e.to);
  await runLoop(tenantId, flow, run._id as mongoose.Types.ObjectId, startedAt, startCursors, {
    currentRecord: triggerRecord, currentModule: triggerModule, depth, hadSkip: false, toStage,
  }, triggerNode.id);
}

/** Resumes exactly one paused run — called only by pollPausedFlows() below,
 * never directly from a trigger/hook. Claims the run atomically (flips it
 * out of 'paused' and clears pauseState/resumeAt in the SAME update) so it
 * can never be resumed twice even if the poll somehow overlaps itself; the
 * findOneAndUpdate's default return value is the document as it was BEFORE
 * the update, so pauseState is still readable off the result even though
 * the DB row has already moved on. */
export async function resumeFlow(tenantId: string, runId: string): Promise<void> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const run = await AutomationFlowRun.findOneAndUpdate(
    { _id: runId, tenantId: tid, status: 'paused' },
    { $set: { status: 'running' }, $unset: { pauseState: '', resumeAt: '' } },
  ).lean();
  if (!run || !run.pauseState) return; // already resumed, deleted, or never actually paused — no-op

  const flow = await AutomationFlow.findOne({ _id: run.flowId, tenantId: tid });
  if (!flow || !flow.enabled) {
    // Adversarial-but-real case: the flow was deleted or disabled while this
    // run sat paused. Finish it plainly rather than crashing or resurrecting
    // logic for a flow that no longer exists/is off.
    logger.error('AutomationFlow resume aborted — flow missing or disabled', { runId, flowId: run.flowId });
    await AutomationFlowRun.updateOne({ _id: runId }, {
      $set: { status: 'failed', finishedAt: new Date(), durationMs: Date.now() - run.startedAt.getTime() },
    }).catch(() => {});
    return;
  }

  await runLoop(tenantId, flow, run._id as mongoose.Types.ObjectId, run.startedAt, run.pauseState.cursor ? [run.pauseState.cursor] : [], {
    currentRecord: run.pauseState.currentRecord, currentModule: run.pauseState.currentModule as PipelineModule,
    depth: run.pauseState.depth, hadSkip: run.pauseState.hadSkip, toStage: run.pauseState.toStage,
  });
}

/** Resolves a paused Approval node via an explicit human decision — never a
 * timer. Mirrors resumeFlow()'s exact atomic-claim pattern (flip out of
 * 'paused', clear pauseState/resumeAt in the SAME update, so a decision can
 * never be applied twice even under a racing double-submit), but the claim
 * query is additionally scoped to `'pauseState.kind': 'approval'` so this
 * can never accidentally hijack a Delay pause (kind absent or 'delay') even
 * under a hypothetical race between the two resume paths. Resolves the next
 * cursor via the decision-tagged edge on the paused node itself
 * (`flow.edges.find(e => e.from === pausedNodeId && e.fromPort ===
 * decision)`) rather than pauseState.cursor, which an Approval pause never
 * sets — Approval, unlike Delay, has two possible resume targets. An
 * Approval node validly configured with only one of its two ports wired
 * (mirrors a condition node's own "up to two edges" shape) means the OTHER
 * decision resolves to no edge at all — runLoop is simply seeded with an
 * empty cursor list, which is exactly how any other node's own unwired
 * branch already ends a run today, not a special error case. */
export async function decideApproval(
  tenantId: string,
  runId: string,
  decision: 'approve' | 'reject',
  decidedByUserId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const run = await AutomationFlowRun.findOneAndUpdate(
    { _id: runId, tenantId: tid, status: 'paused', 'pauseState.kind': 'approval' },
    { $set: { status: 'running' }, $unset: { pauseState: '', resumeAt: '' } },
  ).lean();
  if (!run || !run.pauseState || !run.pauseState.pausedNodeId) {
    return { ok: false, reason: 'No pending approval found for this run (already decided, not paused, or not an approval pause)' };
  }

  const flow = await AutomationFlow.findOne({ _id: run.flowId, tenantId: tid });
  if (!flow || !flow.enabled) {
    // Same adversarial-but-real case resumeFlow() already guards against —
    // the flow was deleted/disabled while this run sat waiting on a decision.
    logger.error('AutomationFlow approval decision aborted — flow missing or disabled', { runId, flowId: run.flowId });
    await AutomationFlowRun.updateOne({ _id: runId }, {
      $set: { status: 'failed', finishedAt: new Date(), durationMs: Date.now() - run.startedAt.getTime() },
    }).catch(() => {});
    return { ok: false, reason: 'The underlying flow was deleted or disabled while this run was paused' };
  }

  const pausedNodeId = run.pauseState.pausedNodeId;
  const decisionAt = new Date();
  await AutomationFlowRun.updateOne({ _id: runId }, {
    $push: {
      steps: {
        nodeId: pausedNodeId, nodeType: 'approval', label: `Approval decision: ${decision}`,
        status: 'success', startedAt: decisionAt, finishedAt: decisionAt, durationMs: 0,
        result: decidedByUserId ? `${decision} by ${decidedByUserId}` : decision,
      },
    },
  }).catch((err) => logger.error('Failed to log approval decision step', { runId, error: (err as Error).message }));

  const nextEdge = flow.edges.find((e) => e.from === pausedNodeId && e.fromPort === decision);
  await runLoop(tenantId, flow, run._id as mongoose.Types.ObjectId, run.startedAt, nextEdge ? [nextEdge.to] : [], {
    currentRecord: run.pauseState.currentRecord, currentModule: run.pauseState.currentModule as PipelineModule,
    depth: run.pauseState.depth, hadSkip: run.pauseState.hadSkip, toStage: run.pauseState.toStage,
  });
  return { ok: true };
}

/** Cron-poll-only resume mechanism (no BullMQ — see the plan's own reasoning:
 * sub-minute precision doesn't matter for delays measured in minutes-to-days,
 * so one code path beats maintaining two). Registered into
 * scheduler.service.ts's initCronJobs(), same cadence as the existing
 * runMeetingReminders() windowed poll. Runs across ALL tenants (a cron job,
 * not a per-request hook) — each due run is resumed independently, and one
 * run throwing can never block the rest. */
export async function pollPausedFlows(): Promise<void> {
  const due = await AutomationFlowRun.find({ status: 'paused', resumeAt: { $lte: new Date() } }).select('_id tenantId').lean();
  for (const run of due) {
    await resumeFlow(String(run.tenantId), String(run._id)).catch((err) =>
      logger.error('AutomationFlow resume failed', { runId: run._id, error: (err as Error).message }));
  }
}

/* ── Hook-in points — same fire-and-forget/depth-cap contract as
   automation-rule.service.ts's runAutomations*, called from the SAME
   existing call sites via a dynamic import from that file (see its own
   hook functions) so zero controllers needed to change for this to exist. */

export async function runFlows(tenantId: string, module: PipelineModule, record: Record<string, any>, toStage: string, depth = 0): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) { logger.error('AutomationFlow chain depth cap reached', { module, depth }); return; }
  try {
    const flows = await AutomationFlow.find({
      tenantId: new mongoose.Types.ObjectId(tenantId), enabled: true,
      'nodes.type': 'trigger', 'nodes.module': module, 'nodes.triggerType': 'status_changed', 'nodes.triggerStage': toStage,
    });
    for (const flow of flows) {
      await executeFlow(tenantId, flow, record, module, toStage, depth).catch((err) => logger.error('Flow run failed', { flowId: flow._id, error: (err as Error).message }));
    }
  } catch (err) { logger.error('runFlows crashed', { module, error: (err as Error).message }); }
}

export async function runFlowsOnCreate(tenantId: string, module: PipelineModule, record: Record<string, any>, depth = 0): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) { logger.error('AutomationFlow chain depth cap reached', { module, depth }); return; }
  try {
    const flows = await AutomationFlow.find({
      tenantId: new mongoose.Types.ObjectId(tenantId), enabled: true,
      'nodes.type': 'trigger', 'nodes.module': module, 'nodes.triggerType': 'record_created',
    });
    for (const flow of flows) {
      await executeFlow(tenantId, flow, record, module, 'created', depth).catch((err) => logger.error('Flow run failed', { flowId: flow._id, error: (err as Error).message }));
    }
  } catch (err) { logger.error('runFlowsOnCreate crashed', { module, error: (err as Error).message }); }
}

export async function runFlowsOnUpdate(tenantId: string, module: PipelineModule, prevRecord: Record<string, any>, newRecord: Record<string, any>, depth = 0): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) { logger.error('AutomationFlow chain depth cap reached', { module, depth }); return; }
  try {
    const flows = await AutomationFlow.find({
      tenantId: new mongoose.Types.ObjectId(tenantId), enabled: true,
      'nodes.type': 'trigger', 'nodes.module': module, 'nodes.triggerType': 'record_updated',
    });
    for (const flow of flows) {
      const triggerNode = flow.nodes.find((n) => n.type === 'trigger');
      if (!triggerNode?.triggerField) continue;
      const before = readSourceField(prevRecord, triggerNode.triggerField);
      const after  = readSourceField(newRecord, triggerNode.triggerField);
      if (String(before ?? '') === String(after ?? '')) continue;
      if (triggerNode.triggerStage && String(after ?? '') !== triggerNode.triggerStage) continue;
      await executeFlow(tenantId, flow, newRecord, module, String(after ?? ''), depth).catch((err) => logger.error('Flow run failed', { flowId: flow._id, error: (err as Error).message }));
    }
  } catch (err) { logger.error('runFlowsOnUpdate crashed', { module, error: (err as Error).message }); }
}

export async function runFlowsOnDelete(tenantId: string, module: PipelineModule, deletedRecord: Record<string, any>, depth = 0): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) { logger.error('AutomationFlow chain depth cap reached', { module, depth }); return; }
  try {
    const flows = await AutomationFlow.find({
      tenantId: new mongoose.Types.ObjectId(tenantId), enabled: true,
      'nodes.type': 'trigger', 'nodes.module': module, 'nodes.triggerType': 'record_deleted',
    });
    for (const flow of flows) {
      await executeFlow(tenantId, flow, deletedRecord, module, 'deleted', depth).catch((err) => logger.error('Flow run failed', { flowId: flow._id, error: (err as Error).message }));
    }
  } catch (err) { logger.error('runFlowsOnDelete crashed', { module, error: (err as Error).message }); }
}

/** Webhook Trigger's Flow-engine dispatch — Advanced Mode equivalent of
 * automation-rule.service.ts's runAutomationOnWebhook(). The caller
 * (automation-webhook.controller.ts) already found this specific flow by its
 * trigger node's webhookToken, so this is just "run it," reusing executeFlow
 * exactly like every other trigger type, at depth 0 (same uncapped-entry-
 * point shape pollScheduledFlows already uses — MAX_LINKED_RECORD_CHAIN_DEPTH
 * is enforced in these wrapper functions, never inside executeFlow itself).
 * `payload` (the parsed webhook JSON body) stands in for "the triggering
 * record"; the trigger node's own `module` field is reused, unchanged, as the
 * nominal module fed into executeFlow — same as it already is for `module`
 * being required-but-functionally-unused on a 'scheduled' trigger node.
 * Never throws. */
export async function runFlowOnWebhook(
  tenantId: string, flow: IAutomationFlow, payload: Record<string, any>,
): Promise<void> {
  const triggerNode = flow.nodes.find((n) => n.type === 'trigger');
  if (!triggerNode?.module) return; // shouldn't happen — module is required on every trigger node
  await executeFlow(tenantId, flow, payload, triggerNode.module as PipelineModule, 'webhook', 0).catch((err) =>
    logger.error('Webhook-triggered flow run failed', { flowId: (flow as any)._id, error: (err as Error).message }));
}

/** Cron-poll for Advanced Mode's own scheduled flows — Flow-engine
 * equivalent of automation-rule.service.ts's pollScheduledRules(), same
 * cadence, registered as a separate cron job so a bug in one engine's poll
 * can never affect the other's. scheduleCron/scheduleModule/scheduleFilter/
 * scheduleLastFiredAt/scheduleCursor live on the trigger NODE (nested in
 * `nodes[]`), not top-level on the Flow document, so advancing them needs a
 * positional array update rather than a plain top-level $set.
 *
 * Cap-continuation logic mirrors pollScheduledRules() exactly — see that
 * function's own doc comment for the full rationale (scheduleCursor marks
 * "still clearing an oversized backlog," making the NEXT poll tick continue
 * via `_id: {$gt: cursor}` instead of re-querying from scratch, which,
 * combined with queryScheduleMatches' stable `_id` ascending sort, guarantees
 * the backlog rotates through every candidate over successive ticks). */
export async function pollScheduledFlows(): Promise<void> {
  const flows = await AutomationFlow.find({
    enabled: true, 'nodes.type': 'trigger', 'nodes.triggerType': 'scheduled',
  });
  const now = new Date();
  for (const flow of flows) {
    const triggerNode = flow.nodes.find((n) => n.type === 'trigger');
    if (!triggerNode?.scheduleCron || !triggerNode.scheduleModule) continue;

    const isContinuation = !!triggerNode.scheduleCursor;
    let isDue = isContinuation;
    if (!isDue) {
      let nextFire: Date;
      try {
        nextFire = cronParser.parseExpression(triggerNode.scheduleCron, { currentDate: triggerNode.scheduleLastFiredAt ?? new Date(0) }).next().toDate();
      } catch (err) {
        logger.error('Invalid scheduleCron on flow trigger node', { flowId: flow._id, error: (err as Error).message });
        continue;
      }
      isDue = nextFire <= now;
    }
    if (!isDue) continue;

    try {
      const tenantId = String(flow.tenantId);
      let filter = conditionsToMongoFilter(triggerNode.scheduleFilter);
      if (isContinuation) {
        filter = { $and: [filter, { _id: { $gt: new mongoose.Types.ObjectId(triggerNode.scheduleCursor) } }] };
      }
      const matches = await queryScheduleMatches(tenantId, triggerNode.scheduleModule, filter, MAX_SCHEDULE_MATCHES_PER_TICK + 1);
      const hasMore = matches.length > MAX_SCHEDULE_MATCHES_PER_TICK;
      const capped = matches.slice(0, MAX_SCHEDULE_MATCHES_PER_TICK);
      if (hasMore) {
        logger.error('Schedule Trigger match cap reached — remainder deferred to next tick', { flowId: flow._id, module: triggerNode.scheduleModule, matched: matches.length, cap: MAX_SCHEDULE_MATCHES_PER_TICK });
      }
      for (const record of capped) {
        await executeFlow(tenantId, flow, record, triggerNode.scheduleModule as PipelineModule, 'scheduled', 0).catch((err) => {
          logger.error('Scheduled flow run failed', { flowId: flow._id, error: (err as Error).message });
        });
      }

      const set: Record<string, any> = {};
      const unset: Record<string, any> = {};
      if (hasMore) {
        set['nodes.$.scheduleCursor'] = String(capped[capped.length - 1]._id);
        if (!isContinuation) set['nodes.$.scheduleLastFiredAt'] = now;
      } else {
        unset['nodes.$.scheduleCursor'] = '';
        if (!isContinuation) set['nodes.$.scheduleLastFiredAt'] = now;
      }
      await AutomationFlow.updateOne(
        { _id: flow._id, 'nodes.id': triggerNode.id },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      ).catch(() => {});
    } catch (err) {
      logger.error('pollScheduledFlows crashed for one flow', { flowId: flow._id, error: (err as Error).message });
      if (!isContinuation) {
        await AutomationFlow.updateOne(
          { _id: flow._id, 'nodes.id': triggerNode.id },
          { $set: { 'nodes.$.scheduleLastFiredAt': now } },
        ).catch(() => {});
      }
    }
  }
}
