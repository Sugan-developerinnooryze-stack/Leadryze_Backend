import mongoose, { Schema, Document } from 'mongoose';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';

export type AutomationActionType = 'send_email' | 'send_sms' | 'send_whatsapp' | 'create_linked_record';
/** 'tenant_admin' resolves to this tenant's own TENANT_ADMIN user — the only
 * (until 'manager') strategy that ignores the record entirely, for "notify a
 * fixed person regardless of which record this is" (Error Branch's own
 * "Notify Admin" case). The User model has no phone field, so this only ever
 * resolves an email — an SMS/WhatsApp node using it correctly skips as "no
 * resolvable recipient", not a bug. 'manager' is the same shape, one level
 * down the hierarchy — resolves this tenant's own MANAGER-role user (Approval
 * node's own "notify a Manager" case), same email-only limitation, same
 * arbitrary-pick-if-multiple simplification (findOne, not "notify all"). */
export type AutomationRecipientStrategy = 'record_contact' | 'assigned_user' | 'tenant_admin' | 'manager';
/** 'scheduled' fires on a recurring cron schedule rather than reacting to a
 * record event — see scheduleCron/scheduleModule/scheduleFilter below.
 * 'webhook' fires from an external HTTP POST hitting a server-generated,
 * secret URL — see webhookToken below. */
export type AutomationTriggerType = 'status_changed' | 'record_created' | 'record_updated' | 'record_deleted' | 'scheduled' | 'webhook';

/** Mirrors the operator set from the user's own spec doc, normalized to
 * valid enum values (the doc's "is empty"/"in list" become is_empty/in_list
 * — spaces aren't usable as literal enum values, everything else is verbatim).
 * Lives here (not in automation-flow.model.ts, where it originated) because
 * Schedule Trigger's own scheduleFilter needs it on AutomationRule too, and
 * this file is the established one-directional home for primitives shared
 * between the two engines — automation-flow.model.ts imports this back, same
 * as it already does for IFieldMapping/AutomationRecipientStrategy/etc. */
export type ConditionOperator =
  | '=' | '!=' | '>' | '<' | '>=' | '<='
  | 'contains' | 'startsWith' | 'endsWith'
  | 'is_empty' | 'is_not_empty' | 'between' | 'in_list' | 'not_in_list';

export interface IFlowCondition {
  /** Read via readSourceField() (Advanced Mode chains) or compiled to a real
   * Mongo query via conditionsToMongoFilter() (Schedule Trigger) — same
   * field, same raw/`data.`/`customFields.` addressing convention either way. */
  field: string;
  operator: ConditionOperator;
  /** Unused for is_empty/is_not_empty. Comma-separated for in_list/not_in_list. */
  value?: string;
  /** Only used by 'between' — the upper bound (value is the lower bound). */
  value2?: string;
}

/** One field on the target record created by a 'create_linked_record' action —
 * either copied verbatim from a field on the SOURCE record ('field', with a
 * '.data.<key>' sourceField for a Custom Module source's EAV blob) or a fixed
 * literal ('static'). Deliberately no formula/expression support — this is
 * meant to stay as simple as the existing send_email/send_sms action shapes. */
export interface IFieldMapping {
  targetField:  string;
  sourceType:   'field' | 'static';
  sourceField?: string;
  staticValue?: string;
}

export interface IAutomationRule extends Document {
  tenantId:          mongoose.Types.ObjectId;
  module:            PipelineModule;
  name:              string;
  enabled:           boolean;
  /** 'status_changed' (the original v1 trigger) requires triggerStage — a
   * literal pipeline-stage key match. 'record_created' fires once whenever a
   * new record is made in this module, independent of any status.
   * 'record_updated' fires when ONE PARTICULAR field (triggerField, any
   * field in getFieldCatalog's list — including tenant Custom Fields)
   * actually changes value — optionally only when it changes TO a specific
   * value (triggerStage, reused rather than adding a redundant third
   * "target value" field), or on ANY change to that field when triggerStage
   * is left unset. 'record_deleted' fires once when a record is removed,
   * with the record's last-known field values available to field mappings
   * exactly like every other trigger. Defaults to 'status_changed' so every
   * rule created before later trigger types existed keeps behaving exactly
   * as it did. */
  triggerType:       AutomationTriggerType;
  /** The tenant's own pipeline stage KEY that fires this rule (not a
   * semantic outcome tag — v1 is deliberately a literal-key match; if a
   * tenant renames the stage, the rule needs re-pointing, same tradeoff
   * every other "pick a stage" UI in this app already has). Required when
   * triggerType === 'status_changed'; for 'record_updated' this doubles as
   * an OPTIONAL "changed to this exact value" filter (see triggerField). */
  triggerStage?:     string;
  /** Which field to watch — required only for triggerType === 'record_updated'.
   * Drawn from the same field catalog as Create Linked Record's field
   * mapping (getFieldCatalog), so this covers built-in schema fields, tenant
   * Custom Fields, and Custom Module fields identically. */
  triggerField?:     string;
  /** Only meaningful for triggerType === 'scheduled' — a real cron expression
   * (validated via cron-parser), not a friendly preset; no UI exists yet for
   * any node/trigger config, so this is configured directly same as everything
   * else. */
  scheduleCron?:      string;
  /** Which module pollScheduledRules() queries when this schedule is due. */
  scheduleModule?:    PipelineModule;
  /** AND-combined, same shape/operators as a condition node — compiled to a
   * real Mongo query (conditionsToMongoFilter) rather than evaluated in JS,
   * since this has to find matching records out of potentially many, not
   * just check one already in hand. Omitted/empty = every record in the
   * module matches. */
  scheduleFilter?:    IFlowCondition[];
  /** Bookkeeping, not user-facing config — when this schedule last actually
   * fired, so the poll knows whether it's due again now. Absent until the
   * first tick. */
  scheduleLastFiredAt?: Date;
  /** Bookkeeping, not user-facing config — set when a due tick's matching set
   * exceeds MAX_SCHEDULE_MATCHES_PER_TICK, to the _id of the last record
   * processed this tick. Its presence means "still clearing an oversized
   * backlog from the current due-episode" — the NEXT poll (even before the
   * cron's own next natural recurrence) resumes from just past this _id
   * instead of re-querying the full matching set from scratch, so an
   * oversized backlog provably rotates through every candidate over
   * successive ticks instead of the same leading subset winning forever.
   * Cleared once a tick's matching set (from that _id onward) fits within
   * the cap. */
  scheduleCursor?:    string;
  /** Only meaningful for triggerType === 'webhook' — a server-generated,
   * never client-writable secret (48 hex chars) used as the URL path segment
   * for POST /api/v1/automation-webhooks/trigger/:token. This IS the only
   * authentication for this trigger type in this pass — there is no
   * signature-verification scheme yet, generic or provider-specific (a
   * deliberately deferred follow-up). Generated/preserved across updates by
   * createRule/updateRule — see their own comments for the exact lifecycle
   * (an edit that keeps triggerType==='webhook' must reuse the existing
   * token, never silently reissue one and break an already-configured
   * external system). */
  webhookToken?:      string;
  actionType:        AutomationActionType;
  /** Required only for send_email/send_sms. */
  templateId?:       string;
  /** 'record_contact' resolves the record's own customer/contact (Lead's own
   * email/phone, a Deal's linked Contact, a Quotation/WorkOrder/Contract/
   * Invoice's linked Customer). 'assigned_user' resolves the internal staff
   * assigned to the record (Work Order/Contract's staffId) — modules with no
   * reliable assignee resolve to nothing and the run is logged as skipped.
   * Only meaningful for send_email/send_sms. */
  recipientStrategy?: AutomationRecipientStrategy;
  /** Populated only when actionType === 'create_linked_record'. */
  targetModule?:       PipelineModule;
  fieldMappings?:      IFieldMapping[];
  /** A field ON the target module to auto-populate with an identifier for
   * the source record, so the newly created record comes out linked back to
   * where it came from instead of just holding copied values. Optional. */
  backReferenceField?: string;
  /** Where this rule's node renders on the visual automation canvas. Purely a
   * display concern (persisted so a dragged node stays put on reload) — never
   * read by the automation engine itself. Absent for any rule never opened on
   * the canvas; the frontend falls back to an auto-layout grid position. */
  canvasPosition?:   { x: number; y: number };
  createdBy?:        string;
  createdAt:         Date;
  updatedAt:         Date;
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

const schema = new Schema<IAutomationRule>(
  {
    tenantId:          { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    module:            { type: String, required: true, trim: true },
    name:              { type: String, required: true, trim: true },
    enabled:           { type: Boolean, default: true },
    triggerType:       { type: String, enum: ['status_changed', 'record_created', 'record_updated', 'record_deleted', 'scheduled', 'webhook'], default: 'status_changed' },
    triggerStage:      { type: String, trim: true },
    triggerField:      { type: String, trim: true },
    scheduleCron:        { type: String, trim: true },
    scheduleModule:      { type: String, trim: true },
    scheduleFilter:      { type: [flowConditionSchema], default: undefined },
    scheduleLastFiredAt: { type: Date },
    scheduleCursor:    { type: String },
    webhookToken:      { type: String, trim: true },
    actionType:        { type: String, enum: ['send_email', 'send_sms', 'send_whatsapp', 'create_linked_record'], required: true },
    templateId:        { type: String },
    recipientStrategy: { type: String, enum: ['record_contact', 'assigned_user', 'tenant_admin', 'manager'], default: 'record_contact' },
    targetModule:       { type: String, trim: true },
    fieldMappings:      { type: [fieldMappingSchema], default: undefined },
    backReferenceField: { type: String, trim: true },
    canvasPosition:    { type: { x: Number, y: Number }, _id: false },
    createdBy:         { type: String },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, module: 1, triggerStage: 1, enabled: 1 });
schema.index({ tenantId: 1, module: 1, triggerType: 1, enabled: 1 });
// Sparse (most rules never have this field) + unique (this index is what
// makes "dispatch by token alone, no tenantId in the query" well-defined —
// see automation-webhooks/automation-webhook.controller.ts).
schema.index({ webhookToken: 1 }, { unique: true, sparse: true });

export const AutomationRule = mongoose.model<IAutomationRule>(
  'AutomationRule',
  schema,
  'native_automation_rules',
);
