import mongoose from 'mongoose';
import crypto from 'crypto';
import cronParser from 'cron-parser';
import { AutomationRule, IAutomationRule, IFieldMapping, IFlowCondition } from './automation-rule.model';
import { PipelineModule, BuiltInPipelineModule } from '../pipeline-config/pipeline-config.model';
import { isValidStageKey, getOrCreateStages } from '../pipeline-config/pipeline-config.service';
import { getTemplateById, renderTemplate } from '../../templates/template.service';
import { resolveRecipient, Recipient } from '../../notifications/recipient-resolver';
import { writeLog } from '../../notifications/email-log.service';
import { sendEmailNow } from '../../messages/brevo.service';
import { sendSmsNow } from '../../messages/twilio.service';
import { sendWhatsAppNow } from '../../messages/whatsapp.service';
import { NativeCustomer } from '../customers/customer.model';
import { NativeStaff } from '../staffs/staff.model';
import { NativeTeam } from '../teams/team.model';
import { User } from '../../auth/auth.model';
import { Tenant } from '../../tenants/tenant.model';
import { Branch } from '../branches/branch.model';
import { CustomModuleDef, CustomRecord } from '../../custom-modules/custom-module.model';
import { listCustomFields } from '../custom-fields/custom-field.service';
import { BUILT_IN_TARGET_FIELDS, ITargetFieldDef } from './target-field-catalog';
import { decrypt, isEncrypted } from '../../../utils/crypto';
import { logger } from '../../../utils/logger';

/** Lead/Customer/Staff all PII-encrypt email/phone at rest (see
 * platform/pii/constants.ts) — every recipient-field read in this file goes
 * through this first, or a rule pointed at a freshly-encrypted record sends
 * to raw ciphertext instead of a real address (silently, since Brevo/Twilio
 * just reject the malformed value rather than throwing something obvious). */
function decryptField(v?: string): string | undefined {
  if (!v) return v;
  return isEncrypted(v) ? decrypt(v) : v;
}

/** Custom Modules have no fixed "this is the customer field" concept the
 * way built-in modules do — this finds the first 'relationship' field that
 * points at Customers or Staff and resolves whatever it's linked to (in that
 * preference order — a module could plausibly have both, and the customer
 * is the more likely intended recipient). Note: unlike Task/Ticket's
 * relatedId (a Mongo _id), a Custom Module relationship field stores the
 * human-readable customerId/staffId (see CustomModuleFormDrawer's
 * RELATIONSHIP_META), so this queries the target model directly by that
 * field rather than reusing resolveRecipient(), which assumes an _id.
 * 'teams' is deliberately not supported — NativeTeam has no email/phone of
 * its own to notify. No matching field, or nothing linked yet → null
 * (skip + log), same as every other unresolvable case here. */
async function resolveCustomModuleRecipient(
  tenantId: string, slug: string, record: Record<string, any>,
): Promise<Recipient | null> {
  const def = await CustomModuleDef.findOne({ tenantId, slug }).select('fields').lean();
  const data = record.data as Record<string, any> | undefined;
  const tid = new mongoose.Types.ObjectId(tenantId);

  const customerField = def?.fields.find((f) => f.fieldType === 'relationship' && f.meta?.targetModule === 'customers');
  const customerId = customerField ? data?.[customerField.key] : undefined;
  if (customerId) {
    const c = await NativeCustomer.findOne({ tenantId: tid, customerId: String(customerId) }).lean();
    if (c) return { email: decryptField(c.email), phone: decryptField(c.phone), name: c.name };
  }

  const staffField = def?.fields.find((f) => f.fieldType === 'relationship' && f.meta?.targetModule === 'staffs');
  const staffId = staffField ? data?.[staffField.key] : undefined;
  if (staffId) {
    const s = await NativeStaff.findOne({ tenantId: tid, staffId: String(staffId) }).lean();
    if (s) return { email: decryptField(s.email), phone: decryptField(s.phone), name: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() || 'there' };
  }

  return null;
}

async function assertValidRule(tenantId: string, module: PipelineModule, triggerStage: string): Promise<void> {
  if (!(await isValidStageKey(tenantId, module, triggerStage))) {
    throw new Error(`"${triggerStage}" is not a valid stage for this tenant's ${module} pipeline`);
  }
}

// Custom Module field types that don't reduce to a single flat scalar value
// — excluded from the catalog since there's no sensible single value to
// copy in or out. 'relationship' is deliberately NOT here: despite its rich
// picker UI, it stores nothing more than the target record's plain
// human-readable ID string in `.data[key]` (see CustomModuleFormDrawer's
// RELATIONSHIP_META) — exactly the same shape as a built-in module's own
// cross-reference fields (Deal.contactId, WorkOrder.contractId), which are
// already valid mapping targets/sources in BUILT_IN_TARGET_FIELDS. Treating
// it as unmappable would block the most natural custom-to-custom linking
// case: writing one module's relationship value straight into another's.
const UNMAPPABLE_CUSTOM_FIELD_TYPES = new Set(['table', 'image', 'images']);

function customFieldToTargetDef(fieldType: string): ITargetFieldDef['type'] {
  switch (fieldType) {
    case 'number': case 'currency': case 'rating': return 'number';
    case 'date': case 'datetime': return 'date';
    case 'boolean': return 'boolean';
    case 'select': case 'multiselect': case 'categoryselect': return 'select';
    default: return 'text';
  }
}

// NativeCustomField (backend/.../custom-fields/) is a SEPARATE "add a field
// to a built-in module" system from Custom Modules above — different type
// vocabulary, same "flat scalar or not" question. 'image'/'images'/'video'/
// 'videos'/'custom_form' don't reduce to one flat value, same reasoning as
// UNMAPPABLE_CUSTOM_FIELD_TYPES above.
const UNMAPPABLE_NATIVE_CUSTOM_FIELD_TYPES = new Set(['image', 'images', 'video', 'videos', 'custom_form']);

function nativeCustomFieldToTargetDef(fieldType: string): ITargetFieldDef['type'] {
  switch (fieldType) {
    case 'number': case 'currency': case 'rating': return 'number';
    case 'date': case 'datetime': return 'date';
    case 'checkbox': case 'boolean': return 'boolean';
    case 'dropdown': case 'radio': case 'multi_select': return 'select';
    default: return 'text';
  }
}

// A tenant's Custom Fields module keys are PLURAL ('leads', 'workorders',
// 'quotations', ...) — a completely separate naming convention from
// PipelineModule's singular keys ('lead', 'workorder', 'quotation', ...).
// relationshipSlugFor() (below) already bridges singular PipelineModule keys
// to a plural convention for Custom Module relationship-field matching —
// reused here for the exact same singular-to-plural translation, since it's
// the same mapping problem, not a new one.

/** Serves both the "copy from" (source) and "write to" (target) field
 * pickers in the rule-builder UI — same function either way, since a
 * built-in module's own fields are equally valid to read from or write to.
 * Built-ins use the hand-authored catalog (no dynamic field metadata exists
 * for them); Custom Modules use their own live field definitions. Any
 * select-type field that's actually a stage/status field gets its `options`
 * filled in here from the tenant's own currently-configured pipeline stages
 * (rather than a hand-authored list, since those are per-tenant and
 * renameable) — this is what lets the rule builder offer a real dropdown of
 * valid values instead of asking someone to type an internal stage key from
 * memory. */
export async function getFieldCatalog(tenantId: string, module: PipelineModule): Promise<ITargetFieldDef[]> {
  if (module.startsWith('custom:')) {
    const slug = module.slice('custom:'.length);
    const def = await CustomModuleDef.findOne({ tenantId, slug }).select('fields pipelineFieldKey').lean();
    const fields = (def?.fields ?? [])
      .filter((f) => !UNMAPPABLE_CUSTOM_FIELD_TYPES.has(f.fieldType))
      .map((f) => ({
        // 'data.' prefixed so this matches readSourceField's/setPayloadField's
        // existing 'data.' branch — a Custom Record's real field values live
        // nested under `.data`, so the catalog key must say so explicitly.
        // (A raw, unprefixed key would round-trip fine for WRITING into a
        // custom-module target, since the payload IS the record's `.data`
        // object there — but silently fail to READ from a custom-module
        // SOURCE record, since readSourceField's plain fallback branch reads
        // `record[key]` directly instead of digging into `record.data[key]`.)
        key: `data.${f.key}`, label: f.label, type: customFieldToTargetDef(f.fieldType),
        // Mongoose array sub-fields default to [] (not undefined) once read
        // back via .lean() — even a 'relationship'/'text' field that never
        // had options set carries a false, truthy empty array here. Only
        // surface `options` for fields that genuinely have some, or the
        // "Fixed value" picker in the UI would wrongly render an empty
        // dropdown instead of a text box for every non-select field.
        options: f.options && f.options.length > 0 ? f.options.map((o) => ({ value: o, label: o })) : undefined,
      }));
    if (def?.pipelineFieldKey) {
      const stages = await getOrCreateStages(tenantId, module);
      const target = fields.find((f) => f.key === `data.${def.pipelineFieldKey}`);
      if (target) target.options = stages.filter((s) => s.isActive).map((s) => ({ value: s.key, label: s.label }));
    }
    return fields;
  }

  let catalog = BUILT_IN_TARGET_FIELDS[module as BuiltInPipelineModule] ?? [];
  const stageField = catalog.find((f) => f.isStageField);
  if (stageField) {
    const stages = await getOrCreateStages(tenantId, module);
    catalog = catalog.map((f) => f === stageField
      ? { ...f, options: stages.filter((s) => s.isActive).map((s) => ({ value: s.key, label: s.label })) }
      : f);
  }

  // Merge in this tenant's own Custom Fields for the module — a completely
  // separate "add a field to a built-in module" system from the hand-authored
  // list above. Without this, a tenant-added field (e.g. Lead.warrantyMonths)
  // would be invisible to automation even though it's a real, live field on
  // the record — see custom-field.service.ts's listCustomFields().
  const customFields = await listCustomFields(tenantId, relationshipSlugFor(module));
  const customFieldDefs = customFields
    .filter((f) => !UNMAPPABLE_NATIVE_CUSTOM_FIELD_TYPES.has(f.fieldType))
    .map((f) => ({
      key: `customFields.${f.fieldKey}`, label: f.label, type: nativeCustomFieldToTargetDef(f.fieldType),
      // Same false-truthy-[] risk as the Custom Module branch above.
      options: f.options && f.options.length > 0 ? f.options.map((o) => ({ value: o, label: o })) : undefined,
    }));

  return [...catalog, ...customFieldDefs];
}

async function assertValidTriggerField(tenantId: string, module: PipelineModule, triggerField: string): Promise<void> {
  const catalog = await getFieldCatalog(tenantId, module);
  if (!catalog.some((f) => f.key === triggerField)) {
    throw new Error(`"${triggerField}" is not a field on ${module}`);
  }
}

/** Phase 6 — mirrors this file's own assertValidTriggerField/assertValidRule
 * precedent: a stale or foreign branch id is rejected at save time, not
 * silently saved as an unreachable scope. Shared by both engines'
 * create/update paths (this one for Simple Mode, assertValidNodes for
 * Advanced Mode). */
async function assertValidBranchIds(tenantId: string, branchIds: string[] | undefined): Promise<void> {
  if (!branchIds || branchIds.length === 0) return;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const validIds = branchIds.filter((id) => mongoose.isValidObjectId(id));
  if (validIds.length !== branchIds.length) {
    throw new Error('branchIds contains an invalid branch id');
  }
  const count = await Branch.countDocuments({ _id: { $in: validIds }, tenantId: tid });
  if (count !== branchIds.length) {
    throw new Error('branchIds contains a branch that does not belong to this tenant');
  }
}

async function assertValidLinkedRecordRule(
  tenantId: string, targetModule: string | undefined, fieldMappings: IFieldMapping[] | undefined,
): Promise<void> {
  if (!targetModule) throw new Error('targetModule is required for a create_linked_record rule');
  if (!fieldMappings || fieldMappings.length === 0) {
    throw new Error('At least one field mapping is required for a create_linked_record rule');
  }
  const catalog = await getFieldCatalog(tenantId, targetModule as PipelineModule);
  for (const m of fieldMappings) {
    if (!catalog.some((f) => f.key === m.targetField)) {
      throw new Error(`"${m.targetField}" is not a field on ${targetModule}`);
    }
    if (m.sourceType === 'field' && !m.sourceField) {
      throw new Error(`Mapping for "${m.targetField}" needs a source field`);
    }
    if (m.sourceType === 'static' && m.staticValue === undefined) {
      throw new Error(`Mapping for "${m.targetField}" needs a static value`);
    }
  }
}

export async function listRules(tenantId: string, module?: string) {
  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  if (module) filter.module = module;
  return AutomationRule.find(filter).sort({ createdAt: -1 }).lean();
}

export async function createRule(tenantId: string, data: Partial<IAutomationRule>) {
  if ((data.triggerType ?? 'status_changed') === 'status_changed') {
    await assertValidRule(tenantId, data.module as PipelineModule, String(data.triggerStage));
  }
  if (data.triggerType === 'record_updated') {
    await assertValidTriggerField(tenantId, data.module as PipelineModule, String(data.triggerField));
  }
  if (data.actionType === 'create_linked_record') {
    await assertValidLinkedRecordRule(tenantId, data.targetModule, data.fieldMappings);
  }
  await assertValidBranchIds(tenantId, data.branchIds);
  if (data.triggerType === 'webhook') {
    data.webhookToken = await generateWebhookToken((t) => AutomationRule.exists({ webhookToken: t }).then(Boolean));
  }
  return AutomationRule.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId) });
}

export async function updateRule(tenantId: string, id: string, data: Partial<IAutomationRule>) {
  if (data.module && data.triggerStage && (data.triggerType ?? 'status_changed') === 'status_changed') {
    await assertValidRule(tenantId, data.module as PipelineModule, String(data.triggerStage));
  }
  if (data.module && data.triggerField && data.triggerType === 'record_updated') {
    await assertValidTriggerField(tenantId, data.module as PipelineModule, data.triggerField);
  }
  if (data.actionType === 'create_linked_record') {
    await assertValidLinkedRecordRule(tenantId, data.targetModule, data.fieldMappings);
  }
  await assertValidBranchIds(tenantId, data.branchIds);
  const tid = new mongoose.Types.ObjectId(tenantId);

  // A rule's actionType gates two mutually-exclusive field groups —
  // create_linked_record's targetModule/fieldMappings/backReferenceField vs
  // send_*'s templateId/recipientStrategy. RuleForm only ever sends the
  // group that currently applies, but $set never touches a key simply
  // absent from the patch — so switching a rule's action type would
  // otherwise leave the OTHER group's old values stale in the database.
  // Harmless to execution (runOneRule branches on actionType first, before
  // ever reading either group), but visibly wrong once the canvas started
  // reading fieldMappings directly for its mapping-preview/connector
  // features: a rule edited away from create_linked_record kept showing a
  // leftover "field → field" preview for a link it no longer creates.
  const unset: Record<string, ''> = {};
  if (data.actionType && data.actionType !== 'create_linked_record') {
    for (const k of ['targetModule', 'fieldMappings', 'backReferenceField'] as const) {
      if (!(k in data)) unset[k] = '';
    }
  } else if (data.actionType === 'create_linked_record') {
    for (const k of ['templateId', 'recipientStrategy'] as const) {
      if (!(k in data)) unset[k] = '';
    }
  }

  // Same stale-value problem on the TRIGGER side, and here it's not just
  // cosmetic: runAutomationsOnUpdate treats a leftover triggerStage as a
  // deliberate "only fire when changed to this exact value" filter (see its
  // own comment). A rule edited from status_changed (triggerStage: 'won')
  // into record_updated with the "changes to" box left blank — meaning
  // "fire on ANY change" — would otherwise keep silently filtering on the
  // OLD stage value forever, since the frontend's `triggerStage: undefined`
  // for that case is stripped by JSON.stringify before it ever reaches here,
  // identical to how the actionType fields above get dropped.
  if (data.triggerType && data.triggerType !== 'status_changed' && !('triggerStage' in data)) {
    unset.triggerStage = '';
  }
  if (data.triggerType && data.triggerType !== 'record_updated' && !('triggerField' in data)) {
    unset.triggerField = '';
  }

  // webhookToken is never client-writable (stripped by Zod before this point
  // regardless), so a rule whose resulting triggerType is 'webhook' always
  // needs the service layer to supply one itself. Reuse the CURRENTLY STORED
  // token if this rule is ALREADY a webhook trigger — editing an unrelated
  // field must never silently reissue a new URL and break an
  // already-configured external system (Stripe, a website form). Mint a
  // fresh one only when genuinely switching into 'webhook' from something
  // else (or one was never issued). A rule moving AWAY from 'webhook' keeps
  // its token untouched — inert, same posture already accepted for
  // scheduleCron/scheduleModule, since every dispatch query filters by
  // triggerType first; a stale token on a non-webhook rule never matches.
  const existingTriggerType = data.triggerType;
  if (existingTriggerType === 'webhook') {
    const existing = await AutomationRule.findOne({ _id: id, tenantId: tid }).select('triggerType webhookToken').lean();
    if (existing?.triggerType === 'webhook' && existing.webhookToken) {
      data.webhookToken = existing.webhookToken;
    } else {
      data.webhookToken = await generateWebhookToken((t) => AutomationRule.exists({ webhookToken: t }).then(Boolean));
    }
  }

  return AutomationRule.findOneAndUpdate(
    { _id: id, tenantId: tid },
    { $set: data, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true },
  );
}

export async function deleteRule(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return AutomationRule.findOneAndDelete({ _id: id, tenantId: tid });
}

/** Resolves who an automation should notify — mirrors resolveRecipient's own
 * philosophy (only return a real, resolvable person; anything else is null,
 * caller skips + logs, never throws). 'record_contact' dispatches per-module
 * since each module links to a person differently; 'assigned_user' only
 * resolves where there's a real staff assignment (Work Order/Contract). */
export async function resolveAutomationRecipient(
  tenantId: string,
  module: PipelineModule,
  record: Record<string, any>,
  strategy: 'record_contact' | 'assigned_user' | 'tenant_admin' | 'manager',
): Promise<Recipient | null> {
  const tid = new mongoose.Types.ObjectId(tenantId);

  if (strategy === 'tenant_admin') {
    // Ignores the record/module entirely — "notify a fixed person" (Error
    // Branch's own "Notify Admin" case), unlike every other strategy here.
    // User has no phone field, so this can only ever resolve an email; an
    // SMS/WhatsApp node using it correctly falls through to "no resolvable
    // recipient" below, not a bug.
    const admin = await User.findOne({ tenantId: tid, role: 'TENANT_ADMIN', isActive: true }).lean();
    if (!admin) return null;
    return { email: admin.email, phone: undefined, name: `${admin.firstName ?? ''} ${admin.lastName ?? ''}`.trim() || 'there' };
  }

  if (strategy === 'manager') {
    // Team-aware first: the record's own assigned staff -> that staff's
    // team -> that team's manager, when the whole chain resolves. Falls
    // back to today's arbitrary tenant-wide pick (same shape as
    // tenant_admin, one level down the hierarchy — Approval node's own
    // "notify a Manager" case) whenever any link in that chain is missing —
    // fully backward-compatible for any tenant that never sets a
    // NativeTeam.managerUserId anywhere.
    const staffId = record.staffId || record.staffIds?.[0] || record.leadOwnerStaffId || record.assignedStaffId;
    if (staffId) {
      const staff = await NativeStaff.findOne({ tenantId: tid, staffId }).select('teamId').lean();
      if (staff?.teamId) {
        const team = await NativeTeam.findOne({ tenantId: tid, _id: staff.teamId }).select('managerUserId').lean();
        if (team?.managerUserId) {
          const teamManager = await User.findOne({ _id: team.managerUserId, tenantId: tid, isActive: true }).lean();
          if (teamManager) {
            return { email: teamManager.email, phone: undefined, name: `${teamManager.firstName ?? ''} ${teamManager.lastName ?? ''}`.trim() || 'there' };
          }
        }
      }
    }
    const manager = await User.findOne({ tenantId: tid, role: 'MANAGER', isActive: true }).lean();
    if (!manager) return null;
    return { email: manager.email, phone: undefined, name: `${manager.firstName ?? ''} ${manager.lastName ?? ''}`.trim() || 'there' };
  }

  if (strategy === 'assigned_user') {
    // Work Order/Contract carry a real staffId/staffIds assignment; Lead and
    // Deal instead carry a staff reference under a module-specific key
    // (leadOwnerStaffId, assignedStaffId) since neither has a generic
    // "assigned staff" concept — see lead.model.ts/deal.schema.ts.
    const staffId = record.staffId || record.staffIds?.[0] || record.leadOwnerStaffId || record.assignedStaffId;
    if (!staffId) return null;
    const s = await NativeStaff.findOne({ tenantId: tid, staffId }).lean();
    if (!s) return null;
    return { email: decryptField(s.email), phone: decryptField(s.phone), name: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() || 'there' };
  }

  if (module.startsWith('custom:')) {
    return resolveCustomModuleRecipient(tenantId, module.slice('custom:'.length), record);
  }

  switch (module) {
    case 'lead':
      return {
        email: decryptField(record.email), phone: decryptField(record.phone),
        name: `${record.firstName ?? ''} ${record.lastName ?? ''}`.trim() || 'there',
      };
    case 'deal':
      if (!record.contactId) return null;
      return resolveRecipient(tenantId, 'contact', record.contactId);
    case 'task':
    case 'ticket':
      if (!record.relatedModule || !record.relatedId) return null;
      return resolveRecipient(tenantId, record.relatedModule, record.relatedId);
    case 'quotation':
    case 'workorder':
    case 'contract':
    case 'invoice': {
      if (!record.customerId) return null;
      const c = await NativeCustomer.findOne({ tenantId: tid, customerId: record.customerId }).lean();
      if (!c) return null;
      return { email: decryptField(c.email), phone: decryptField(c.phone), name: c.name };
    }
    default:
      return null;
  }
}

/** Reads a value off the source record for a 'field'-type mapping — record
 * root key for built-in modules, 'data.<key>' for a Custom Module source's
 * EAV blob (same `record.data ?? record` fallback buildVariables() uses), or
 * 'customFields.<key>' for a tenant Custom Field on a built-in module (see
 * getFieldCatalog's customFieldDefs — every key it emits for those uses this
 * exact prefix, so this is the read-side half of that same convention). */
export function readSourceField(record: Record<string, any>, sourceField: string): unknown {
  if (sourceField.startsWith('data.')) {
    return (record.data as Record<string, any> | undefined)?.[sourceField.slice('data.'.length)];
  }
  if (sourceField.startsWith('customFields.')) {
    return (record.customFields as Record<string, any> | undefined)?.[sourceField.slice('customFields.'.length)];
  }
  return record[sourceField];
}

/** Writes a value into a create_linked_record payload — the write-side
 * counterpart to readSourceField. A 'customFields.<key>' target must nest
 * under a `customFields` object (that's the real shape every built-in
 * module's schema expects), NOT set a literal flat key containing a dot —
 * `payload['customFields.x'] = v` would silently fail to populate the field
 * at all, since Mongoose has no idea "customFields.x" means "customFields:
 * { x: v }". Every other target field (built-in root keys, or a Custom
 * Module's own flat `.data` keys) is set directly, unchanged from before. */
export function setPayloadField(payload: Record<string, unknown>, targetField: string, value: unknown): void {
  if (targetField.startsWith('customFields.')) {
    const key = targetField.slice('customFields.'.length);
    const existing = (payload.customFields as Record<string, unknown> | undefined) ?? {};
    payload.customFields = { ...existing, [key]: value };
    return;
  }
  // A 'data.<key>' target field means the target is itself a Custom Module
  // (see getFieldCatalog's matching comment) — createRecordInTargetModule
  // passes this whole payload straight through as the new record's `.data`,
  // so the prefix must be stripped back off before writing, unlike
  // 'customFields.' above which genuinely needs a nested sub-object.
  if (targetField.startsWith('data.')) {
    payload[targetField.slice('data.'.length)] = value;
    return;
  }
  payload[targetField] = value;
}

/** A source record's own human-readable identifier, for stamping into a
 * newly created linked record's backReferenceField — falls through each
 * built-in module's own ID field, then Custom Records' recordId, then _id. */
export function sourceIdentifierOf(record: Record<string, any>): string {
  return String(
    record.leadId ?? record.quotationId ?? record.workOrderId ?? record.contractId ??
    record.invoiceId ?? record.recordId ?? record._id ?? '',
  );
}

export const MAX_LINKED_RECORD_CHAIN_DEPTH = 3;

/** Phase 5 emergency kill switch's guard predicate — factored out to its own
 * pure function (shared by both engines: runOneRule here, and executeFlow/
 * resumeFlow/decideApproval in automation-flow.service.ts) so it's reliably
 * unit-testable without a live Mongo connection (see
 * tests/automation-kill-switch.test.ts) — every call site still does its own
 * `Tenant.findById(tenantId).select('settings.automationsPaused').lean()`
 * fetch (that part isn't unit-testable without a DB, and doesn't need to be —
 * it's a single well-established `.lean()` read, same shape as five other
 * precedents elsewhere in this codebase), only the boolean interpretation of
 * the result is pulled out here.
 *
 * A tenant with no `automationsPaused` field at all (every pre-existing
 * tenant — this field only gets a real value written once someone actually
 * toggles the switch) is treated identically to an explicit `false`:
 * `.lean()` reads don't materialize Mongoose's own schema default the way a
 * hydrated document would, so the safety here comes from this function's own
 * falsy check, not from the schema default applying — confirmed live against
 * a real, untouched tenant during Phase 5 verification. Deliberately reads
 * nothing else off the tenant object (in particular, never a per-flow
 * `enabled` value — that's a completely independent concept living on
 * AutomationFlow documents, not Tenant, and this function has no way to see
 * it even if it wanted to). */
export function isAutomationPausedForTenant(
  tenant: { settings?: { automationsPaused?: boolean } } | null | undefined,
): boolean {
  return !!tenant?.settings?.automationsPaused;
}

/** Phase 6 branch scoping — pure predicate, shared by both engines'
 * per-record dispatchers (the runFlowsOnX family and the runAutomationsOnX
 * family), checked per matched
 * flow/rule right alongside the existing triggerField/triggerStage JS
 * refinement those functions already do after their own Mongo `.find()` —
 * `branchIds` lives inside the matched document already fetched, not
 * something the initial query filter can usefully pre-filter on beyond
 * what it already does.
 *
 * Absent/empty branchIds = unscoped trigger, matches every branch — today's
 * exact behavior for every pre-existing flow/rule. A record whose own
 * `branchId` is null/undefined never matches a branch-scoped trigger
 * (confirmed decision, Phase 6 planning) — a branchless record isn't
 * confirmed to belong to any of the configured branches. Not used for
 * webhook triggers at all (rejected at save time instead — see
 * automation-flow.validation.ts/automation-rule.validation.ts). */
export function matchesBranchScope(
  branchIds: string[] | undefined,
  record: { branchId?: unknown },
): boolean {
  if (!branchIds || branchIds.length === 0) return true;
  if (record.branchId === null || record.branchId === undefined) return false;
  return branchIds.includes(String(record.branchId));
}

/** Server-generated only, never client-writable — used as the URL path
 * segment for a webhook-triggered rule/flow (POST /api/v1/automation-
 * webhooks/trigger/:token). 192 bits, same randomBytes(24).toString('hex')
 * idiom already used for clientId in auth.service.ts. The retry-until-unique
 * loop is a defense-in-depth formality, not a load-bearing necessity — at
 * this bit length a collision is astronomically improbable — the schema's
 * own sparse unique index is the real guarantee. */
export async function generateWebhookToken(alreadyExists: (token: string) => Promise<boolean>): Promise<string> {
  let token = '';
  let tries = 0;
  do {
    token = crypto.randomBytes(24).toString('hex');
    tries++;
  } while (tries < 10 && await alreadyExists(token));
  return token;
}

/** Calls the target module's OWN service-layer create function (not the raw
 * Mongoose model) so the new record gets the exact same treatment a normal
 * user-created record would: auto-numbering, stage validation, PII
 * encryption, etc. Dynamic import() (not static top-of-file imports) to
 * avoid a circular-dependency risk — several of these services already
 * import this file for their own runAutomations calls. */
export async function createRecordInTargetModule(
  tenantId: string, targetModule: string, payload: Record<string, unknown>, depth: number,
): Promise<Record<string, any>> {
  if (targetModule.startsWith('custom:')) {
    // createCustomRecord fires the new record's own automations internally
    // (unlike the built-in creates below) — passing depth through here is
    // what lets that internal firing respect the SAME chain-depth cap,
    // rather than resetting to 0 and becoming uncappable (see
    // fireCustomModuleAutomations' comment in custom-module.service.ts).
    const { createCustomRecord } = await import('../../custom-modules/custom-module.service');
    return createCustomRecord(tenantId, targetModule.slice('custom:'.length), payload, 'automation', depth);
  }
  switch (targetModule as BuiltInPipelineModule) {
    case 'lead': {
      const { createLead } = await import('../leads/lead.service');
      return createLead({ ...payload, tenantId });
    }
    case 'deal': {
      const { createDeal } = await import('../deals/deal.service');
      return createDeal(tenantId, payload as any);
    }
    case 'task': {
      const { createTask } = await import('../tasks/task.service');
      return createTask(tenantId, payload as any);
    }
    case 'ticket': {
      const { createTicket } = await import('../tickets/ticket.service');
      return createTicket(tenantId, payload as any);
    }
    case 'quotation': {
      const { createQuotation } = await import('../quotations/quotation.service');
      return createQuotation({ ...payload, tenantId });
    }
    case 'workorder': {
      const { createWorkorder } = await import('../workorders/workorder.service');
      return createWorkorder({ ...payload, tenantId });
    }
    case 'contract': {
      const { createContract } = await import('../contracts/contract.service');
      return createContract({ ...payload, tenantId });
    }
    case 'invoice': {
      const { createInvoice } = await import('../invoices/invoice.service');
      return createInvoice({ ...payload, tenantId });
    }
    default:
      throw new Error(`Unknown target module: ${targetModule}`);
  }
}

/** Calls the target module's OWN service-layer update function — the
 * update-family counterpart to createRecordInTargetModule above, backing
 * Advanced Mode's update_record/assign_record/change_status actions
 * (automation-flow.service.ts's processOneNode). `id` is ALWAYS
 * String(currentRecord._id) — the record the flow's own trigger already
 * resolved via a tenant-scoped query — never a value read from node
 * configuration; there is no such field on those 3 action types' node
 * schema. This is the primary defense against "a misconfigured or
 * malicious node targets an arbitrary record by ID," not a runtime check
 * layered on top of a configurable id.
 *
 * `scope` is deliberately never passed, verified per-module (not assumed
 * uniform) rather than blindly copying create's own "runs unscoped"
 * precedent: every one of the 8 built-ins' update* functions filters
 * `{_id, tenantId}` before anything else (confirmed by direct read of each
 * — Lead/Quotation/Workorder/Contract/Invoice at `{_id: id, tenantId: tid}`,
 * Deal/Task/Ticket at the same shape with args reordered), so a cross-tenant
 * id can never match another tenant's record regardless of scope. Not
 * passing a live-user DataScope (self/team/all) is a considered choice, not
 * an oversight: authoring/editing/testing a flow already requires
 * automation.create/.edit/.execute (Manager+/Admin only — Agent holds none
 * of these), automation execution itself is a background/system process
 * with no live "acting user" session at run time (matching
 * createRecordInTargetModule's own already-accepted precedent), and
 * automation.publish/.delete are Admin-only — a Manager-authored update
 * action cannot affect real, live traffic until an Admin explicitly
 * publishes it. */
export async function updateRecordInTargetModule(
  tenantId: string, targetModule: string, id: string, payload: Record<string, unknown>, depth: number,
): Promise<Record<string, any> | null> {
  if (targetModule.startsWith('custom:')) {
    const { updateCustomRecord } = await import('../../custom-modules/custom-module.service');
    return updateCustomRecord(tenantId, targetModule.slice('custom:'.length), id, payload, depth);
  }
  switch (targetModule as BuiltInPipelineModule) {
    case 'lead': {
      const { updateLead } = await import('../leads/lead.service');
      return updateLead(id, tenantId, payload);
    }
    case 'deal': {
      const { updateDeal } = await import('../deals/deal.service');
      return updateDeal(tenantId, id, payload as any);
    }
    case 'task': {
      const { updateTask } = await import('../tasks/task.service');
      return updateTask(tenantId, id, payload as any);
    }
    case 'ticket': {
      const { updateTicket } = await import('../tickets/ticket.service');
      return updateTicket(tenantId, id, payload as any);
    }
    case 'quotation': {
      const { updateQuotation } = await import('../quotations/quotation.service');
      return updateQuotation(id, tenantId, payload);
    }
    case 'workorder': {
      const { updateWorkorder } = await import('../workorders/workorder.service');
      return updateWorkorder(id, tenantId, payload);
    }
    case 'contract': {
      const { updateContract } = await import('../contracts/contract.service');
      return updateContract(id, tenantId, payload);
    }
    case 'invoice': {
      const { updateInvoice } = await import('../invoices/invoice.service');
      return updateInvoice(id, tenantId, payload);
    }
    default:
      throw new Error(`Unknown target module: ${targetModule}`);
  }
}

/** Executes a 'create_linked_record' rule — resolves each field mapping into
 * a payload, optionally stamps a back-reference to the source record, and
 * creates the new record via the target's own service function. Fires the
 * target's own on-create automations afterward (its service function alone
 * doesn't — only its HTTP controller does, which this dispatcher bypasses on
 * purpose), guarded by a depth cap so a rule can't chain into an infinite
 * loop of create_linked_record rules calling each other. */
// Custom Module relationship fields store the OTHER module's slug in plural
// form (see CustomModuleFormDrawer's BUILTIN_SLUGS: 'leads','deals',
// 'quotations','workorders',...), while PipelineModule keys are singular
// ('lead','deal',...) — this bridges the two naming conventions so a
// relationship field can be matched against a rule's targetModule. Regular
// +s pluralization covers all 8 built-ins (no irregular plurals among them).
const PIPELINE_MODULE_TO_RELATIONSHIP_SLUG: Record<BuiltInPipelineModule, string> = {
  lead: 'leads', deal: 'deals', task: 'tasks', ticket: 'tickets',
  quotation: 'quotations', workorder: 'workorders', contract: 'contracts', invoice: 'invoices',
};

function relationshipSlugFor(module: string): string {
  return module.startsWith('custom:')
    ? module.slice('custom:'.length)
    : PIPELINE_MODULE_TO_RELATIONSHIP_SLUG[module as BuiltInPipelineModule] ?? module;
}

async function writeSourceBackReference(
  tenantId: string, sourceModule: PipelineModule, sourceRecord: Record<string, any>,
  targetModule: string, createdRecord: Record<string, any>,
): Promise<void> {
  if (!sourceModule.startsWith('custom:')) return;
  const slug = sourceModule.slice('custom:'.length);
  const def = await CustomModuleDef.findOne({ tenantId, slug }).select('fields').lean();
  const targetSlug = relationshipSlugFor(targetModule);
  const relField = def?.fields.find((f) => f.fieldType === 'relationship' && f.meta?.targetModule === targetSlug);
  if (!relField) return;

  // Deliberately a raw, targeted $set — NOT the public updateCustomRecord().
  // That function unconditionally re-fires this same source record's own
  // status_changed automations based on whatever the pipeline field's
  // CURRENT value is (it has no way to know whether this particular save
  // actually changed it). Since this write happens as a side effect of one
  // of those very automations already running, going through the public
  // path here recreates the exact trigger condition on every pass —
  // an infinite loop of ever-more created records for any status_changed
  // rule paired with a back-reference. Stamping a reference ID is not a
  // meaningful status change and must never re-trigger automations.
  await CustomRecord.updateOne(
    { tenantId, moduleSlug: slug, _id: sourceRecord._id },
    { $set: { [`data.${relField.key}`]: sourceIdentifierOf(createdRecord) } },
  );
}

async function runCreateLinkedRecordAction(
  tenantId: string,
  sourceModule: PipelineModule,
  sourceRecord: Record<string, any>,
  rule: IAutomationRule,
  depth: number,
): Promise<void> {
  const sourceId = String(sourceRecord._id ?? sourceRecord.recordId ?? '');
  try {
    const payload: Record<string, unknown> = {};
    for (const m of rule.fieldMappings ?? []) {
      const value = m.sourceType === 'static' ? m.staticValue : readSourceField(sourceRecord, m.sourceField!);
      setPayloadField(payload, m.targetField, value);
    }
    if (rule.backReferenceField) {
      setPayloadField(payload, rule.backReferenceField, sourceIdentifierOf(sourceRecord));
    }

    const created = await createRecordInTargetModule(tenantId, rule.targetModule!, payload, depth + 1);

    // Best-effort: if the SOURCE is a Custom Module with a relationship field
    // pointed at the target module, patch that field with the new record's
    // ID so the source ends up linked to it too (mirrors what lead
    // conversion / contract-visit auto-generation already do for their own
    // fixed pairs). Only Custom Module sources have relationship-field
    // metadata to hang this off — built-in sources have no generic
    // "this field points at that module" concept, so they're skipped here.
    await writeSourceBackReference(tenantId, sourceModule, sourceRecord, rule.targetModule!, created).catch(() => {});

    await writeLog({
      tenantId, channel: 'system', kind: 'automation', sourceModule, sourceId,
      status: 'sent', bodyPreview: `Created a ${rule.targetModule} record via rule "${rule.name}"`,
    });

    // Built-in modules' create*() service functions do NOT fire their own
    // record_created automations (only their HTTP controllers do, which
    // this dispatcher intentionally bypasses) — so this explicit call is
    // required for built-in targets. Custom Module targets already fired
    // theirs above, inside createRecordInTargetModule's createCustomRecord
    // call (with the SAME depth), so calling this again here would
    // double-fire them.
    if (!rule.targetModule!.startsWith('custom:')) {
      await runAutomationsOnCreate(tenantId, rule.targetModule as PipelineModule, created, depth + 1);
    }
  } catch (err) {
    await writeLog({
      tenantId, channel: 'system', kind: 'automation', sourceModule, sourceId,
      status: 'failed', errorMessage: (err as Error).message,
    });
  }
}

/** Renders a single catalog-typed value the same deterministic way
 * regardless of caller — a Date becomes a plain YYYY-MM-DD (never
 * `String(dateObj)`'s verbose default), everything else via plain
 * `String(v)` (already correct for text/number/boolean/select), and a
 * missing/undefined value becomes '' rather than the literal text
 * "undefined"/"null" — a template must never leak either. */
function renderCatalogValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** `catalog`, when passed, adds one `record.<catalogKey>` entry per field —
 * namespaced under `record.` (not top-level) because several catalog keys
 * collide with the 5 legacy names below (deal/quotation's own `title`;
 * legacy `status` is the TRIGGER's resolved toStage, literally 'created' for
 * a create trigger, not the record's real status field) — a silent
 * overwrite here would be a real regression, not cosmetic. Only ever driven
 * by getFieldCatalog()'s own hand-authored, scalar-only allowlist (never a
 * raw record dump) — this is what keeps a `[object Object]`/secret-field
 * leak structurally impossible rather than merely avoided by convention:
 * readSourceField only ever reads a key the catalog explicitly exposes, and
 * none of the 8 built-in modules' schemas carry a password/token/secret
 * shaped field for the catalog to expose in the first place (that's
 * exclusively User/Connector territory, never touched by this catalog). */
export function buildVariables(
  record: Record<string, any>, recipientName: string, toStage: string, catalog?: ITargetFieldDef[],
): Record<string, string> {
  // Custom Module records store their tenant-defined field values under
  // `.data` (an EAV blob), not on the record root like built-in modules —
  // fall back to that nested bag for the same best-effort lookups.
  const d: Record<string, any> = record.data ?? record;
  const variables: Record<string, string> = {
    name:    recipientName,
    status:  toStage,
    title:   String(d.title ?? d.subject ?? d.firstName ?? d.name ?? ''),
    id:      String(
      record.leadId ?? record.quotationId ?? record.workOrderId ??
      record.contractId ?? record.invoiceId ?? record.recordId ?? record._id ?? '',
    ),
    company: String(d.company ?? d.companyName ?? ''),
    today:   new Date().toISOString().slice(0, 10),
  };
  for (const field of catalog ?? []) {
    variables[`record.${field.key}`] = renderCatalogValue(readSourceField(record, field.key));
  }
  return variables;
}

async function runOneRule(
  tenantId: string,
  module: PipelineModule,
  record: Record<string, any>,
  toStage: string,
  rule: IAutomationRule,
  depth = 0,
): Promise<void> {
  // Emergency kill switch (Phase 5) — the single choke point every one of
  // this engine's own dispatchers (runAutomations/OnCreate/OnUpdate/
  // OnDelete, the webhook handler, the scheduled-rule poll) funnels through
  // before any real action runs, so one guard here covers all of Simple
  // Mode — this engine never shared a kill switch with the Flow engine
  // before this phase, so this is the fix for that gap, not a duplicate of
  // executeFlow()'s own guard.
  const tenantForPause = await Tenant.findById(tenantId).select('settings.automationsPaused').lean();
  if (isAutomationPausedForTenant(tenantForPause)) return;

  if (rule.actionType === 'create_linked_record') {
    return runCreateLinkedRecordAction(tenantId, module, record, rule, depth);
  }

  const sourceId = String(record._id);
  // 'send_whatsapp' resolves a recipient's phone number exactly like 'send_sms'
  // does (WhatsApp Business messaging targets the same number) — the only
  // difference is which provider function and log channel gets used below.
  const channel: 'email' | 'sms' | 'whatsapp' =
    rule.actionType === 'send_email' ? 'email' : rule.actionType === 'send_whatsapp' ? 'whatsapp' : 'sms';

  const template = await getTemplateById(tenantId, rule.templateId!);
  if (!template) {
    await writeLog({
      tenantId, channel, kind: 'automation',
      sourceModule: module, sourceId, status: 'skipped', errorMessage: 'Template not found',
    });
    return;
  }

  const recipient = await resolveAutomationRecipient(tenantId, module, record, rule.recipientStrategy ?? 'record_contact');
  if (!recipient || (channel === 'email' && !recipient.email) || ((channel === 'sms' || channel === 'whatsapp') && !recipient.phone)) {
    await writeLog({
      tenantId, channel, kind: 'automation', sourceModule: module, sourceId,
      status: 'skipped', errorMessage: 'No resolvable recipient',
    });
    return;
  }

  const catalog = await getFieldCatalog(tenantId, module);
  const variables = buildVariables(record, recipient.name, toStage, catalog);
  const body = renderTemplate(template.body, variables);

  if (rule.actionType === 'send_email') {
    const subject = renderTemplate(template.subject || `Update: ${variables.title || variables.id}`, variables);
    try {
      const messageId = await sendEmailNow({ to: recipient.email!, toName: recipient.name, subject, htmlContent: body });
      await writeLog({
        tenantId, channel: 'email', kind: 'automation', sourceModule: module, sourceId,
        recipientName: recipient.name, recipientEmail: recipient.email, subject,
        bodyPreview: body.replace(/<[^>]+>/g, ' '),
        status: messageId ? 'sent' : 'skipped', providerMessageId: messageId ?? undefined,
        errorMessage: messageId ? undefined : 'Email channel not configured',
      });
    } catch (err) {
      await writeLog({
        tenantId, channel: 'email', kind: 'automation', sourceModule: module, sourceId,
        recipientName: recipient.name, recipientEmail: recipient.email, subject,
        status: 'failed', errorMessage: (err as Error).message,
      });
    }
  } else if (rule.actionType === 'send_whatsapp') {
    // sendWhatsAppNow never rejects (same contract as sendSmsNow) — status is
    // derived from its return value.
    const messageId = await sendWhatsAppNow(recipient.phone!, body);
    await writeLog({
      tenantId, channel: 'whatsapp', kind: 'automation', sourceModule: module, sourceId,
      recipientName: recipient.name, recipientPhone: recipient.phone, bodyPreview: body,
      status: messageId ? 'sent' : 'failed', providerMessageId: messageId ?? undefined,
      errorMessage: messageId ? undefined : 'WhatsApp send failed or not configured',
    });
  } else {
    // sendSmsNow never rejects — status is derived from its return value.
    const sid = await sendSmsNow({ to: recipient.phone!, body });
    await writeLog({
      tenantId, channel: 'sms', kind: 'automation', sourceModule: module, sourceId,
      recipientName: recipient.name, recipientPhone: recipient.phone, bodyPreview: body,
      status: sid ? 'sent' : 'failed', providerMessageId: sid ?? undefined,
      errorMessage: sid ? undefined : 'SMS send failed or not configured',
    });
  }
}

/**
 * Hook-in point — call this from a module's update service/controller right
 * after a status-changing save succeeds, same explicit fire-and-forget shape
 * as sendOnCreateConfirmation(). Looks up this tenant's enabled rules for
 * this module+stage and runs each; never throws.
 */
export async function runAutomations(
  tenantId: string,
  module: PipelineModule,
  record: Record<string, any>,
  toStage: string,
  depth = 0,
  /** Threaded straight through to the internal runFlows cascade below —
   * see AutomationFlowRun.triggeredByRunId's own doc comment. Every
   * existing caller omits this (undefined, correct for a genuine external
   * trigger); only Advanced Mode's update_record/assign_record/
   * change_status/create_linked_record actions (automation-flow.service.ts)
   * pass their own currently-executing run's id. */
  triggeredByRunId?: mongoose.Types.ObjectId,
): Promise<void> {
  // Enforced centrally here (not just where automation-rule.service.ts
  // itself calls back in) so this cap holds regardless of HOW deep we are —
  // including a Custom Module's own create/update hooks calling straight
  // back in with a threaded depth, which is the one path that used to have
  // no cap at all (see fireCustomModuleAutomations' comment).
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) {
    logger.error('Automation chain depth cap reached — stopping further chaining', { module, depth });
    return;
  }
  try {
    const rules = await AutomationRule.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      module, triggerType: 'status_changed', triggerStage: toStage, enabled: true,
    }).lean();
    for (const rule of rules) {
      if (!matchesBranchScope((rule as unknown as IAutomationRule).branchIds, record)) continue;
      await runOneRule(tenantId, module, record, toStage, rule as unknown as IAutomationRule, depth).catch((err) => {
        logger.error('Automation rule run failed', { ruleId: rule._id, module, error: (err as Error).message });
      });
    }
  } catch (err) {
    logger.error('runAutomations crashed', { module, error: (err as Error).message });
  }

  // Dynamic import — same reason as createRecordInTargetModule's own dynamic
  // imports (see its comment): automation-flow.service.ts imports several
  // primitives back FROM this file, so a static top-of-file import here
  // would be a genuine circular module dependency. "Advanced Mode" flows
  // (see automation-flow.model.ts) fire alongside Simple Mode rules, sharing
  // the SAME depth cap, from the SAME call sites — no controller changes
  // needed for flows to exist at all.
  await import('../automation-flows/automation-flow.service')
    .then(({ runFlows }) => runFlows(tenantId, module, record, toStage, depth, triggeredByRunId))
    .catch((err) => logger.error('runFlows dispatch crashed', { module, error: (err as Error).message }));
}

/**
 * Second hook-in point, for rules that fire on creation instead of a status
 * change — call this from a module's create service/controller right after
 * the new record is saved. Same fire-and-forget shape, never throws.
 */
export async function runAutomationsOnCreate(
  tenantId: string,
  module: PipelineModule,
  record: Record<string, any>,
  depth = 0,
  triggeredByRunId?: mongoose.Types.ObjectId,
): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) {
    logger.error('Automation chain depth cap reached — stopping further chaining', { module, depth });
    return;
  }
  try {
    const rules = await AutomationRule.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      module, triggerType: 'record_created', enabled: true,
    }).lean();
    for (const rule of rules) {
      if (!matchesBranchScope((rule as unknown as IAutomationRule).branchIds, record)) continue;
      await runOneRule(tenantId, module, record, 'created', rule as unknown as IAutomationRule, depth).catch((err) => {
        logger.error('Automation rule (record_created) run failed', { ruleId: rule._id, module, error: (err as Error).message });
      });
    }
  } catch (err) {
    logger.error('runAutomationsOnCreate crashed', { module, error: (err as Error).message });
  }

  await import('../automation-flows/automation-flow.service')
    .then(({ runFlowsOnCreate }) => runFlowsOnCreate(tenantId, module, record, depth, triggeredByRunId))
    .catch((err) => logger.error('runFlowsOnCreate dispatch crashed', { module, error: (err as Error).message }));
}

/**
 * Third hook-in point, for rules watching one particular field for ANY
 * change (or a change TO a specific value, via triggerStage) — call this
 * from a module's update service/controller right after a save succeeds,
 * passing BOTH the record as it was before and as it is now. Unlike
 * runAutomations (which only checks the record's CURRENT value against a
 * configured stage — fine for a genuine stage machine, wrong for "did this
 * change" semantics), this explicitly diffs old vs new and only fires when
 * the watched field's value actually moved. Same fire-and-forget shape,
 * never throws.
 */
export async function runAutomationsOnUpdate(
  tenantId: string,
  module: PipelineModule,
  prevRecord: Record<string, any>,
  newRecord: Record<string, any>,
  depth = 0,
  triggeredByRunId?: mongoose.Types.ObjectId,
): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) {
    logger.error('Automation chain depth cap reached — stopping further chaining', { module, depth });
    return;
  }
  try {
    const rules = await AutomationRule.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      module, triggerType: 'record_updated', enabled: true,
    }).lean();
    for (const rule of rules) {
      const r = rule as unknown as IAutomationRule;
      if (!matchesBranchScope(r.branchIds, newRecord)) continue;
      if (!r.triggerField) continue;
      const before = readSourceField(prevRecord, r.triggerField);
      const after = readSourceField(newRecord, r.triggerField);
      // String-normalized, not ===, so two equal-but-distinct Date object
      // instances (a real risk here — Mongoose hands back real Date objects
      // for date-typed fields, never the same reference twice) don't get
      // mistaken for "changed" when the underlying value is identical.
      if (String(before ?? '') === String(after ?? '')) continue;
      // Optional "changed TO this exact value" filter — triggerStage is
      // reused rather than adding a redundant third field for it.
      if (r.triggerStage && String(after ?? '') !== r.triggerStage) continue;

      await runOneRule(tenantId, module, newRecord, String(after ?? ''), r, depth).catch((err) => {
        logger.error('Automation rule (record_updated) run failed', { ruleId: rule._id, module, error: (err as Error).message });
      });
    }
  } catch (err) {
    logger.error('runAutomationsOnUpdate crashed', { module, error: (err as Error).message });
  }

  await import('../automation-flows/automation-flow.service')
    .then(({ runFlowsOnUpdate }) => runFlowsOnUpdate(tenantId, module, prevRecord, newRecord, depth, triggeredByRunId))
    .catch((err) => logger.error('runFlowsOnUpdate dispatch crashed', { module, error: (err as Error).message }));
}

/**
 * Fourth hook-in point, for rules that fire when a record is removed — call
 * this from a module's delete service/controller right before/after the
 * record is actually deleted, passing the record's last-known field values
 * (field mappings and templates read it exactly like any other trigger).
 * Same fire-and-forget shape, never throws.
 */
export async function runAutomationsOnDelete(
  tenantId: string,
  module: PipelineModule,
  deletedRecord: Record<string, any>,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_LINKED_RECORD_CHAIN_DEPTH) {
    logger.error('Automation chain depth cap reached — stopping further chaining', { module, depth });
    return;
  }
  try {
    const rules = await AutomationRule.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      module, triggerType: 'record_deleted', enabled: true,
    }).lean();
    for (const rule of rules) {
      if (!matchesBranchScope((rule as unknown as IAutomationRule).branchIds, deletedRecord)) continue;
      await runOneRule(tenantId, module, deletedRecord, 'deleted', rule as unknown as IAutomationRule, depth).catch((err) => {
        logger.error('Automation rule (record_deleted) run failed', { ruleId: rule._id, module, error: (err as Error).message });
      });
    }
  } catch (err) {
    logger.error('runAutomationsOnDelete crashed', { module, error: (err as Error).message });
  }

  await import('../automation-flows/automation-flow.service')
    .then(({ runFlowsOnDelete }) => runFlowsOnDelete(tenantId, module, deletedRecord, depth))
    .catch((err) => logger.error('runFlowsOnDelete dispatch crashed', { module, error: (err as Error).message }));
}

/** Fifth hook-in point — Webhook Trigger. Unlike the four above, this isn't
 * looked up by module+triggerType (the caller, automation-webhook.controller
 * .ts, already found the specific matching rule by webhookToken) — this is
 * just the "run its configured action" half, reusing runOneRule exactly like
 * every other trigger type, at depth 0 (a fresh top-level firing; the same
 * uncapped-entry-point shape pollScheduledRules already uses, since the
 * MAX_LINKED_RECORD_CHAIN_DEPTH cap is enforced in these wrapper functions,
 * never inside runOneRule itself — so the cap still applies correctly to
 * anything chained FROM this run). `payload` is the parsed webhook JSON body
 * standing in for "the record" — runOneRule/buildVariables/readSourceField
 * don't care that it's not a real Mongoose document. Never throws. */
export async function runAutomationOnWebhook(
  tenantId: string, rule: IAutomationRule, payload: Record<string, any>,
): Promise<void> {
  try {
    await runOneRule(tenantId, rule.module, payload, 'webhook', rule, 0);
  } catch (err) {
    logger.error('Webhook-triggered automation rule run failed', { ruleId: (rule as any)._id, error: (err as Error).message });
  }
}

/* ── Schedule Trigger — query translation + poll (shared by both engines) ──
   Unlike every other trigger, this one isn't driven by a record event — it
   fires on a recurring cron schedule and finds ITS OWN matching records, so
   the "condition" vocabulary already built for condition nodes has to become
   a real Mongo query here instead of an in-memory check against one record
   already in hand. */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** '=' / '!=' equality — coerces the literal string value to a boolean or
 * number when it looks like one, so `amount = 50000` matches a genuinely
 * numeric stored field instead of only ever matching a literal string "50000". */
function coerceEqValue(raw: string | undefined): any {
  if (raw === undefined) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(n)) return n;
  return raw;
}

/** Comparison operators (`>`,`<`,`>=`,`<=`,`between`) resolve to either a
 * Date or a number — needed for exactly the "Check Expired Contracts"
 * (`endDate <= today`) case Schedule Trigger's own example is built around,
 * which a plain parseFloat (today's condition-node behavior) can't express
 * at all. Shared by BOTH the in-memory condition-node evaluator and this
 * file's Mongo-filter translator, so the same condition config behaves
 * identically wherever it's used. The literal keywords 'today'/'now' are
 * recognized on top of real ISO-date-like strings; anything else falls back
 * to the original numeric parse, so existing numeric conditions (e.g.
 * `expectedRevenue > 50000`) are completely unaffected. */
export function resolveComparableValue(raw: string | undefined): number | Date {
  const v = (raw ?? '').trim();
  if (v === 'today') { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }
  if (v === 'now') return new Date();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return parseFloat(v);
}

function oneConditionToMongoFilter(cond: IFlowCondition): Record<string, any> {
  const { field, operator, value, value2 } = cond;
  switch (operator) {
    case '=':  return { [field]: coerceEqValue(value) };
    case '!=': return { [field]: { $ne: coerceEqValue(value) } };
    case '>':  return { [field]: { $gt:  resolveComparableValue(value) } };
    case '<':  return { [field]: { $lt:  resolveComparableValue(value) } };
    case '>=': return { [field]: { $gte: resolveComparableValue(value) } };
    case '<=': return { [field]: { $lte: resolveComparableValue(value) } };
    case 'contains':   return { [field]: { $regex: escapeRegex(value ?? ''), $options: 'i' } };
    case 'startsWith': return { [field]: { $regex: '^' + escapeRegex(value ?? ''), $options: 'i' } };
    case 'endsWith':   return { [field]: { $regex: escapeRegex(value ?? '') + '$', $options: 'i' } };
    case 'is_empty':     return { $or: [{ [field]: null }, { [field]: '' }, { [field]: { $exists: false } }] };
    case 'is_not_empty': return { [field]: { $nin: [null, ''], $exists: true } };
    case 'between':    return { [field]: { $gte: resolveComparableValue(value), $lte: resolveComparableValue(value2) } };
    case 'in_list':     return { [field]: { $in:  (value ?? '').split(',').map((s) => s.trim()) } };
    case 'not_in_list': return { [field]: { $nin: (value ?? '').split(',').map((s) => s.trim()) } };
    default: return {};
  }
}

/** AND-combines every condition into one Mongo filter — empty/undefined
 * means "every record in the module matches," same as an empty conditions
 * array already evaluates true for a condition node. Conditions are combined
 * via `$and` (not a flat object merge) so two conditions targeting the SAME
 * field — e.g. `amount >= 1000` AND `amount <= 5000`, the "between" case
 * spelled out as two conditions instead of one — don't silently overwrite
 * each other's filter clause. */
export function conditionsToMongoFilter(conditions: IFlowCondition[] | undefined): Record<string, any> {
  const filters = (conditions ?? []).map(oneConditionToMongoFilter);
  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { $and: filters };
}

/** Not tenant-configurable — a fixed safety ceiling, same precedent as
 * MAX_LINKED_RECORD_CHAIN_DEPTH. A tenant whose backlog exceeds this gets
 * throttled across multiple ticks (the rest are picked up next time this
 * schedule is due), never a single mass-fire. */
export const MAX_SCHEDULE_MATCHES_PER_TICK = 200;

/** Queries which records currently match a Schedule Trigger's filter —
 * shared by pollScheduledRules (this file) and pollScheduledFlows
 * (automation-flow.service.ts), so the "which module, which Mongoose model"
 * mapping exists in exactly one place. Always sorted by `_id` ascending —
 * not just for determinism's own sake, but because pollScheduledRules'/
 * pollScheduledFlows' cursor-continuation logic (scheduleCursor, `_id: {$gt}`)
 * depends on a stable, monotonic order to guarantee an oversized backlog
 * rotates through every candidate across ticks instead of the same leading
 * subset winning forever. */
export async function queryScheduleMatches(
  tenantId: string, module: string, filter: Record<string, any>, limit: number,
): Promise<Record<string, any>[]> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  if (module.startsWith('custom:')) {
    const slug = module.slice('custom:'.length);
    return CustomRecord.find({ tenantId, moduleSlug: slug, ...filter }).sort({ _id: 1 }).limit(limit).lean();
  }
  switch (module as BuiltInPipelineModule) {
    case 'lead':      { const { Lead } = await import('../leads/lead.model'); return Lead.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'deal':      { const { Deal } = await import('../deals/deal.model'); return Deal.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'task':      { const { Task } = await import('../tasks/task.model'); return Task.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'ticket':    { const { Ticket } = await import('../tickets/ticket.model'); return Ticket.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'quotation': { const { NativeQuotation } = await import('../quotations/quotation.model'); return NativeQuotation.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'workorder': { const { NativeWorkorder } = await import('../workorders/workorder.model'); return NativeWorkorder.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'contract':  { const { NativeContract } = await import('../contracts/contract.model'); return NativeContract.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    case 'invoice':   { const { NativeInvoice } = await import('../invoices/invoice.model'); return NativeInvoice.find({ tenantId: tid, ...filter }).sort({ _id: 1 }).limit(limit).lean(); }
    default: return [];
  }
}

/** Cron-poll for Simple Mode's own scheduled rules — every minute (cron
 * patterns can be per-minute), registered from scheduler.service.ts. For
 * each due rule: query its matching records (capped), fire runOneRule() once
 * per match at depth 0 (a fresh top-level firing, same as every other
 * trigger), then advance scheduleLastFiredAt regardless of match count so a
 * quiet tick still ticks forward correctly.
 *
 * Cap-continuation: a rule whose matching set exceeds MAX_SCHEDULE_MATCHES_
 * PER_TICK doesn't wait for its own cron's next natural recurrence to clear
 * the backlog — scheduleCursor marks "still working through the batch from
 * the due-episode that started at scheduleLastFiredAt," and its mere
 * presence makes the NEXT poll tick (even one minute later, regardless of
 * the rule's own cron cadence) continue that same batch via `_id: {$gt:
 * cursor}` instead of re-querying the full matching set — which, combined
 * with queryScheduleMatches' stable `_id` ascending sort, guarantees the
 * backlog rotates through every candidate over successive ticks rather than
 * the same leading subset winning forever. scheduleLastFiredAt itself only
 * advances on the FIRST tick of a due-episode, not on every continuation
 * tick, so the rule's own next natural recurrence stays anchored to when it
 * originally became due, not to how long clearing a large backlog took. */
export async function pollScheduledRules(): Promise<void> {
  const rules = await AutomationRule.find({ triggerType: 'scheduled', enabled: true }).lean();
  const now = new Date();
  for (const rule of rules) {
    const r = rule as unknown as IAutomationRule;
    if (!r.scheduleCron || !r.scheduleModule) continue;

    const isContinuation = !!r.scheduleCursor;
    let isDue = isContinuation;
    if (!isDue) {
      let nextFire: Date;
      try {
        nextFire = cronParser.parseExpression(r.scheduleCron, { currentDate: r.scheduleLastFiredAt ?? new Date(0) }).next().toDate();
      } catch (err) {
        logger.error('Invalid scheduleCron on rule', { ruleId: rule._id, error: (err as Error).message });
        continue;
      }
      isDue = nextFire <= now;
    }
    if (!isDue) continue;

    try {
      const tenantId = String(r.tenantId);
      let filter = conditionsToMongoFilter(r.scheduleFilter);
      // Phase 6 branch scoping — folded directly into the compiled Mongo
      // filter (unlike the per-record dispatchers' JS-side post-filter)
      // since this function already builds and executes a real query over a
      // potentially large candidate set (bounded by
      // MAX_SCHEDULE_MATCHES_PER_TICK) — pushing the branch filter into the
      // DB query is strictly more efficient than fetching every branch's
      // matches just to discard most of them afterward.
      if (r.branchIds && r.branchIds.length > 0) {
        filter = { $and: [filter, { branchId: { $in: r.branchIds.map((id) => new mongoose.Types.ObjectId(id)) } }] };
      }
      if (isContinuation) {
        filter = { $and: [filter, { _id: { $gt: new mongoose.Types.ObjectId(r.scheduleCursor) } }] };
      }
      const matches = await queryScheduleMatches(tenantId, r.scheduleModule, filter, MAX_SCHEDULE_MATCHES_PER_TICK + 1);
      const hasMore = matches.length > MAX_SCHEDULE_MATCHES_PER_TICK;
      const capped = matches.slice(0, MAX_SCHEDULE_MATCHES_PER_TICK);
      if (hasMore) {
        logger.error('Schedule Trigger match cap reached — remainder deferred to next tick', { ruleId: rule._id, module: r.scheduleModule, matched: matches.length, cap: MAX_SCHEDULE_MATCHES_PER_TICK });
      }
      for (const record of capped) {
        await runOneRule(tenantId, r.scheduleModule as PipelineModule, record, 'scheduled', r, 0).catch((err) => {
          logger.error('Scheduled rule run failed', { ruleId: rule._id, error: (err as Error).message });
        });
      }

      const update: Record<string, any> = {};
      if (hasMore) {
        update.$set = { scheduleCursor: String(capped[capped.length - 1]._id) };
        if (!isContinuation) update.$set.scheduleLastFiredAt = now;
      } else {
        update.$unset = { scheduleCursor: '' };
        if (!isContinuation) update.$set = { scheduleLastFiredAt: now };
      }
      await AutomationRule.updateOne({ _id: rule._id }, update).catch(() => {});
    } catch (err) {
      logger.error('pollScheduledRules crashed for one rule', { ruleId: rule._id, error: (err as Error).message });
      if (!isContinuation) {
        await AutomationRule.updateOne({ _id: rule._id }, { $set: { scheduleLastFiredAt: now } }).catch(() => {});
      }
    }
  }
}
