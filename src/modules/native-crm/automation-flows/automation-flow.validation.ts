import { z } from 'zod';
import cronParser from 'cron-parser';

// Same closed set as automation-rule.validation.ts's moduleSchema — kept as
// a separate literal here rather than importing it, since Zod schemas built
// with `z.union` aren't cleanly re-exportable/extensible across files, and
// duplicating one small literal is simpler than fighting Zod's types for it.
const moduleSchema = z.union([
  z.enum(['lead', 'deal', 'task', 'ticket', 'quotation', 'workorder', 'contract', 'invoice']),
  z.string().trim().regex(/^custom:.+/),
]);

// Loop's own iteration source — a superset of moduleSchema (see
// LoopSourceModule's own comment in automation-flow.model.ts for why
// 'customer' isn't just added to the shared moduleSchema itself).
const loopSourceModuleSchema = z.union([
  z.enum(['lead', 'deal', 'task', 'ticket', 'quotation', 'workorder', 'contract', 'invoice', 'customer']),
  z.string().trim().regex(/^custom:.+/),
]);

// Not tenant-configurable beyond this — a hard system ceiling, same
// precedent as MAX_SCHEDULE_MATCHES_PER_TICK/MAX_LINKED_RECORD_CHAIN_DEPTH.
const MAX_LOOP_ITEMS = 2000;

const fieldMappingSchema = z.object({
  targetField: z.string().trim().min(1),
  sourceType:  z.enum(['field', 'static']),
  sourceField: z.string().trim().min(1).optional(),
  staticValue: z.string().optional(),
});

const triggerTypeSchema = z.enum(['status_changed', 'record_created', 'record_updated', 'record_deleted', 'scheduled', 'webhook']);
const actionTypeSchema  = z.enum([
  'send_email', 'send_sms', 'send_whatsapp', 'create_linked_record',
  'update_record', 'assign_record', 'change_status', 'add_note', 'webhook_call',
]);

const webhookHeaderSchema = z.object({
  key:   z.string().trim().min(1),
  value: z.string().min(1),
});

/** Best-effort, synchronous save-time check only — this schema is consumed
 * via `.safeParse()` (validate.middleware.ts), which can't await an async
 * refinement, so a real DNS lookup isn't possible here. Only catches a
 * webhookUrl whose HOSTNAME IS ITSELF a literal, obviously-disallowed IP
 * (someone typing `http://127.0.0.1/...` or the metadata IP directly) — a
 * domain name always passes this check regardless of what it resolves to.
 * The AUTHORITATIVE check is resolveAndPinSafeUrl (utils/url-safety.ts),
 * which performs a real DNS lookup + pins the connection, run immediately
 * before every actual call (including every retry) in
 * automation-flow.service.ts's processOneNode — this is deliberately not a
 * duplicate of that full logic, just a cheap early UI-level catch, matching
 * this file's own established "duplicate one small literal, don't fight
 * Zod's types to share it" precedent (see moduleSchema's own comment). */
function isObviouslyUnsafeLiteralHost(hostname: string): boolean {
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

const webhookUrlSchema = z.string().trim().min(1).refine((url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !isObviouslyUnsafeLiteralHost(parsed.hostname);
  } catch {
    return false;
  }
}, { message: 'webhookUrl must be a valid http(s) URL and not an obviously internal/private address' });
const scheduleCronSchema = z.string().trim().min(1).refine((expr) => {
  try { cronParser.parseExpression(expr); return true; } catch { return false; }
}, { message: 'scheduleCron is not a valid cron expression' });
const conditionOperatorSchema = z.enum([
  '=', '!=', '>', '<', '>=', '<=', 'contains', 'startsWith', 'endsWith',
  'is_empty', 'is_not_empty', 'between', 'in_list', 'not_in_list',
]);

const flowConditionSchema = z.object({
  field:    z.string().trim().min(1),
  operator: conditionOperatorSchema,
  value:    z.string().optional(),
  value2:   z.string().optional(),
}).superRefine((c, ctx) => {
  if (c.operator === 'between' && (c.value === undefined || c.value2 === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value2'], message: '"between" needs both value and value2' });
  }
  if (!['is_empty', 'is_not_empty'].includes(c.operator) && c.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `"${c.operator}" needs a value` });
  }
});

// Retry's own strict enums — a literal union (not z.number().min/max) so a
// direct API caller can't set a nonsensical backoff like 3ms or 10 hours;
// matches this file's existing "strict enum over freeform number" style.
const retryCountSchema     = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const retryBackoffMsSchema = z.union([z.literal(1000), z.literal(5000), z.literal(30000), z.literal(60000)]);

const flowNodeSchema = z.object({
  id:   z.string().trim().min(1),
  type: z.enum(['trigger', 'action', 'condition', 'delay', 'merge', 'subFlow', 'loop', 'approval']),

  module:       moduleSchema.optional(),
  triggerType:  triggerTypeSchema.optional(),
  triggerStage: z.string().trim().min(1).optional(),
  triggerField: z.string().trim().min(1).optional(),
  scheduleCron:   scheduleCronSchema.optional(),
  scheduleModule: moduleSchema.optional(),
  scheduleFilter: z.array(flowConditionSchema).optional(),
  // Phase 6 branch scoping — Branch document ids, tenant-ownership checked
  // against real data in assertValidNodes (Zod alone can't reach the DB).
  // Absent/empty = unscoped (today's exact behavior). Not meaningful on a
  // webhook trigger — rejected below, in this same node's own superRefine.
  branchIds: z.array(z.string().trim().min(1)).optional(),

  actionType:         actionTypeSchema.optional(),
  templateId:         z.string().trim().min(1).optional(),
  recipientStrategy:  z.enum(['record_contact', 'assigned_user', 'tenant_admin', 'manager']).optional(),
  targetModule:       moduleSchema.optional(),
  fieldMappings:      z.array(fieldMappingSchema).optional(),
  backReferenceField: z.string().trim().min(1).optional(),
  retryCount:         retryCountSchema.optional(),
  retryBackoffMs:     retryBackoffMsSchema.optional(),

  // Add Note (actionType === 'add_note' only)
  noteSubject:    z.string().trim().min(1).optional(),
  noteBody:       z.string().optional(),
  noteAssignedTo: z.string().trim().min(1).optional(),

  // Webhook (actionType === 'webhook_call' only)
  webhookUrl:     webhookUrlSchema.optional(),
  webhookMethod:  z.enum(['POST', 'PUT', 'PATCH']).optional(),
  webhookHeaders: z.array(webhookHeaderSchema).optional(),

  conditions: z.array(flowConditionSchema).optional(),

  // Bounded 1–129600 (90 days), not a strict preset enum — see the model
  // file's own comment on why Delay's duration isn't Retry-style presets.
  delayMinutes: z.number().int().min(1).max(129600).optional(),

  // Sub-Flow — the callee's own shape (no subFlow/delay/approval nodes
  // inside it) is checked at the service layer (createFlow/updateFlow),
  // since it requires a DB lookup Zod can't perform.
  targetFlowId: z.string().trim().min(1).optional(),

  // Loop
  loopSourceModule: loopSourceModuleSchema.optional(),
  loopFilter:       z.array(flowConditionSchema).optional(),
  loopSubFlowId:    z.string().trim().min(1).optional(),
  loopMaxItems:     z.number().int().min(1).max(MAX_LOOP_ITEMS).optional(),
  loopBatchSize:    z.number().int().min(1).optional(),
  loopConcurrency:  z.number().int().min(1).optional(),

  // Approval — recipientStrategy for who decides; no required-value beyond
  // that (defaults to 'manager' at the service layer if omitted).
  approvalRecipientStrategy: z.enum(['record_contact', 'assigned_user', 'tenant_admin', 'manager']).optional(),
}).superRefine((node, ctx) => {
  if (node.type === 'trigger') {
    if (!node.module) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['module'], message: 'Trigger node requires a module' });
    if ((node.triggerType ?? 'status_changed') === 'status_changed' && !node.triggerStage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerStage'], message: 'triggerStage is required when triggerType is status_changed' });
    }
    if (node.triggerType === 'record_updated' && !node.triggerField) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerField'], message: 'triggerField is required when triggerType is record_updated' });
    }
    if (node.triggerType === 'scheduled') {
      if (!node.scheduleCron) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'scheduleCron is required when triggerType is scheduled' });
      if (!node.scheduleModule) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleModule'], message: 'scheduleModule is required when triggerType is scheduled' });
    }
    // A webhook payload isn't "a record in a branch" — no branch concept to
    // check, so a save-time rejection here is a clearer signal than a
    // config field that looks meaningful but is silently ignored at
    // execution time (same posture as every other "field X only valid on
    // trigger type Y" rule in this block).
    if (node.triggerType === 'webhook' && node.branchIds && node.branchIds.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchIds'], message: 'branchIds is not supported on webhook triggers' });
    }
  } else if (node.type === 'action') {
    if (!node.actionType) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actionType'], message: 'Action node requires an actionType' });
    if ((node.actionType === 'send_email' || node.actionType === 'send_sms' || node.actionType === 'send_whatsapp') && !node.templateId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateId'], message: 'templateId is required for send_email/send_sms/send_whatsapp' });
    }
    if (node.actionType === 'create_linked_record') {
      if (!node.targetModule) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetModule'], message: 'targetModule is required for create_linked_record' });
      if (!node.fieldMappings || node.fieldMappings.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldMappings'], message: 'At least one field mapping is required for create_linked_record' });
      }
    }
    if (node.actionType === 'update_record' || node.actionType === 'assign_record' || node.actionType === 'change_status') {
      if (!node.fieldMappings || node.fieldMappings.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldMappings'], message: 'At least one field mapping is required' });
      }
      // Assign Record / Change Status are UI-constrained to exactly one
      // mapping (onto the module's isAssigneeField/isStageField catalog
      // entry — enforced by the builder, not re-validated against a live
      // catalog lookup here, since Zod has no DB access); Update Record
      // allows any number.
      if ((node.actionType === 'assign_record' || node.actionType === 'change_status') && node.fieldMappings && node.fieldMappings.length > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldMappings'], message: `${node.actionType} supports exactly one field mapping` });
      }
    }
    if (node.actionType === 'add_note' && !node.noteSubject) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['noteSubject'], message: 'noteSubject is required for add_note' });
    }
    if (node.actionType === 'webhook_call' && !node.webhookUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webhookUrl'], message: 'webhookUrl is required for webhook_call' });
    }
  } else if (node.type === 'condition') {
    if (!node.conditions || node.conditions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions'], message: 'Condition node requires at least one condition' });
    }
  } else if (node.type === 'delay') {
    if (node.delayMinutes === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delayMinutes'], message: 'Delay node requires delayMinutes' });
    }
  } else if (node.type === 'subFlow') {
    if (!node.targetFlowId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetFlowId'], message: 'Sub-Flow node requires targetFlowId' });
    }
  } else if (node.type === 'loop') {
    if (!node.loopSourceModule) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopSourceModule'], message: 'Loop node requires loopSourceModule' });
    if (!node.loopSubFlowId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopSubFlowId'], message: 'Loop node requires loopSubFlowId' });
    if (node.loopMaxItems === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopMaxItems'], message: 'Loop node requires loopMaxItems' });
    if (node.loopBatchSize === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopBatchSize'], message: 'Loop node requires loopBatchSize' });
    if (node.loopConcurrency === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopConcurrency'], message: 'Loop node requires loopConcurrency' });
  }
  // Retry config only makes sense where there's an action to retry — a
  // Loop node's own retryCount/retryBackoffMs govern per-item retry of its
  // Sub-Flow invocation, same fields/meaning as an action node's.
  if (node.type !== 'action' && node.type !== 'loop' && (node.retryCount !== undefined || node.retryBackoffMs !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retryCount'], message: 'retryCount/retryBackoffMs are only valid on action or loop nodes' });
  }
  // delayMinutes only makes sense on the node type that waits.
  if (node.type !== 'delay' && node.delayMinutes !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delayMinutes'], message: 'delayMinutes is only valid on delay nodes' });
  }
  // targetFlowId only makes sense on the node type that calls another flow.
  if (node.type !== 'subFlow' && node.targetFlowId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetFlowId'], message: 'targetFlowId is only valid on subFlow nodes' });
  }
  // Loop's own fields only make sense on a loop node.
  if (node.type !== 'loop' && (node.loopSourceModule !== undefined || node.loopFilter !== undefined || node.loopSubFlowId !== undefined || node.loopMaxItems !== undefined || node.loopBatchSize !== undefined || node.loopConcurrency !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loopSourceModule'], message: 'Loop fields are only valid on loop nodes' });
  }
  // approvalRecipientStrategy only makes sense on an approval node.
  if (node.type !== 'approval' && node.approvalRecipientStrategy !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalRecipientStrategy'], message: 'approvalRecipientStrategy is only valid on approval nodes' });
  }
  // Deliberately NO "noteSubject/webhookUrl only valid on their own
  // actionType" cross-check here, unlike delayMinutes/targetFlowId/loop
  // fields above — matching this codebase's own established precedent for
  // every OTHER action-specific field (targetModule/fieldMappings/
  // templateId/recipientStrategy have never had one either). Switching a
  // node's actionType in the builder doesn't clear the previous type's
  // fields from local state (same as it never has for create_linked_record
  // <-> send_email), so rejecting a stale leftover field here would produce
  // a confusing save failure the existing fields don't. The backend simply
  // never reads a field that doesn't belong to the node's current
  // actionType, which is the same posture as every action type before this
  // pass.
  // Schedule fields only make sense on a trigger node (and really only a
  // scheduled one, but the "wrong triggerType" case is already caught above).
  if (node.type !== 'trigger' && (node.scheduleCron !== undefined || node.scheduleModule !== undefined || node.scheduleFilter !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'scheduleCron/scheduleModule/scheduleFilter are only valid on trigger nodes' });
  }
});

const flowEdgeSchema = z.object({
  from:     z.string().trim().min(1),
  to:       z.string().trim().min(1),
  fromPort: z.enum(['true', 'false', 'success', 'failure', 'approve', 'reject']).optional(),
});

const canvasPositionsSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));

export const createAutomationFlowSchema = z.object({
  name:    z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  nodes:   z.array(flowNodeSchema).min(1),
  edges:   z.array(flowEdgeSchema),
  canvasPositions: canvasPositionsSchema.optional(),
});

export const updateAutomationFlowSchema = z.object({
  name:    z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  nodes:   z.array(flowNodeSchema).min(1).optional(),
  edges:   z.array(flowEdgeSchema).optional(),
  canvasPositions: canvasPositionsSchema.optional(),
});

// PATCH /automation-flows/runs/:id/decision — the Approval node's own
// resume-via-decision body (never a timer).
export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

// POST /automation-flows/:id/dry-run — the one real record dryRunFlow()
// simulates the flow against.
export const dryRunFlowSchema = z.object({
  sampleModule:   moduleSchema,
  sampleRecordId: z.string().trim().min(1),
});
