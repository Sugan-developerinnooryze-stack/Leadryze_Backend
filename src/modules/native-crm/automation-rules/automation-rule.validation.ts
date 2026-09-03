import { z } from 'zod';
import cronParser from 'cron-parser';

// Built-ins are a closed set; `custom:<slug>` covers tenant-built Custom
// Modules — real existence of the slug is checked at the service layer
// (assertValidRule → isValidStageKey), same as triggerStage below.
const moduleSchema = z.union([
  z.enum(['lead', 'deal', 'task', 'ticket', 'quotation', 'workorder', 'contract', 'invoice']),
  z.string().trim().regex(/^custom:.+/),
]);

const fieldMappingSchema = z.object({
  targetField: z.string().trim().min(1),
  sourceType:  z.enum(['field', 'static']),
  sourceField: z.string().trim().min(1).optional(),
  staticValue: z.string().optional(),
});

// Same shape Schedule Trigger's scheduleFilter and Advanced Mode's condition
// nodes both use — one operator vocabulary, two consumers (JS evaluation for
// a condition node already holding a record, a real Mongo query for Schedule
// Trigger finding which records match).
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

const actionTypeSchema = z.enum(['send_email', 'send_sms', 'send_whatsapp', 'create_linked_record']);
const triggerTypeSchema = z.enum(['status_changed', 'record_created', 'record_updated', 'record_deleted', 'scheduled', 'webhook']);
const canvasPositionSchema = z.object({ x: z.number(), y: z.number() });
const scheduleCronSchema = z.string().trim().min(1).refine((expr) => {
  try { cronParser.parseExpression(expr); return true; } catch { return false; }
}, { message: 'scheduleCron is not a valid cron expression' });

function refineActionShape(data: {
  actionType?: string; templateId?: string; targetModule?: string; fieldMappings?: unknown[];
}, ctx: z.RefinementCtx) {
  if ((data.actionType === 'send_email' || data.actionType === 'send_sms' || data.actionType === 'send_whatsapp') && !data.templateId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateId'], message: 'templateId is required for send_email/send_sms/send_whatsapp' });
  }
  if (data.actionType === 'create_linked_record') {
    if (!data.targetModule) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetModule'], message: 'targetModule is required for create_linked_record' });
    }
    if (!data.fieldMappings || data.fieldMappings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldMappings'], message: 'At least one field mapping is required for create_linked_record' });
    }
  }
}

function refineTriggerShape(data: {
  triggerType?: string; triggerStage?: string; triggerField?: string;
  scheduleCron?: string; scheduleModule?: string; branchIds?: string[];
}, ctx: z.RefinementCtx) {
  if ((data.triggerType ?? 'status_changed') === 'status_changed' && !data.triggerStage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerStage'], message: 'triggerStage is required when triggerType is status_changed' });
  }
  if (data.triggerType === 'record_updated' && !data.triggerField) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerField'], message: 'triggerField is required when triggerType is record_updated' });
  }
  if (data.triggerType === 'scheduled') {
    if (!data.scheduleCron) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'scheduleCron is required when triggerType is scheduled' });
    if (!data.scheduleModule) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleModule'], message: 'scheduleModule is required when triggerType is scheduled' });
  }
  if (data.triggerType !== 'scheduled' && (data.scheduleCron !== undefined || data.scheduleModule !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'scheduleCron/scheduleModule/scheduleFilter are only valid when triggerType is scheduled' });
  }
  // Phase 6 — same reasoning as automation-flow.validation.ts's identical
  // check: a webhook payload isn't "a record in a branch," so this is a
  // save-time rejection, not a silently-ignored field.
  if (data.triggerType === 'webhook' && data.branchIds && data.branchIds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchIds'], message: 'branchIds is not supported on webhook triggers' });
  }
}

export const createAutomationRuleSchema = z.object({
  module:            moduleSchema,
  name:              z.string().trim().min(1).max(120),
  enabled:           z.boolean().optional(),
  triggerType:       triggerTypeSchema.optional(),
  // Required only for 'status_changed' (and doubles as an optional "changed
  // to this value" filter for 'record_updated') — enforced below via
  // superRefine rather than here, since triggerType defaults when omitted.
  triggerStage:      z.string().trim().min(1).optional(),
  triggerField:      z.string().trim().min(1).optional(),
  scheduleCron:      scheduleCronSchema.optional(),
  scheduleModule:    moduleSchema.optional(),
  scheduleFilter:    z.array(flowConditionSchema).optional(),
  branchIds:         z.array(z.string().trim().min(1)).optional(),
  actionType:        actionTypeSchema,
  templateId:        z.string().trim().min(1).optional(),
  recipientStrategy: z.enum(['record_contact', 'assigned_user', 'tenant_admin', 'manager']).optional(),
  targetModule:       moduleSchema.optional(),
  fieldMappings:      z.array(fieldMappingSchema).optional(),
  backReferenceField: z.string().trim().min(1).optional(),
  canvasPosition:     canvasPositionSchema.optional(),
}).superRefine((data, ctx) => {
  refineTriggerShape(data, ctx);
  refineActionShape(data, ctx);
});

export const updateAutomationRuleSchema = z.object({
  module:            moduleSchema.optional(),
  name:              z.string().trim().min(1).max(120).optional(),
  enabled:           z.boolean().optional(),
  triggerType:       triggerTypeSchema.optional(),
  triggerStage:      z.string().trim().min(1).optional(),
  triggerField:      z.string().trim().min(1).optional(),
  scheduleCron:      scheduleCronSchema.optional(),
  scheduleModule:    moduleSchema.optional(),
  scheduleFilter:    z.array(flowConditionSchema).optional(),
  branchIds:         z.array(z.string().trim().min(1)).optional(),
  actionType:        actionTypeSchema.optional(),
  templateId:        z.string().trim().min(1).optional(),
  recipientStrategy: z.enum(['record_contact', 'assigned_user', 'tenant_admin', 'manager']).optional(),
  targetModule:       moduleSchema.optional(),
  fieldMappings:      z.array(fieldMappingSchema).optional(),
  backReferenceField: z.string().trim().min(1).optional(),
  canvasPosition:     canvasPositionSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.triggerType) refineTriggerShape(data, ctx);
  if (data.actionType) refineActionShape(data, ctx);
});
