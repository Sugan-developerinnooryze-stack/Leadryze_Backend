import mongoose from 'mongoose';
import { CRM_WRITE_MODULE_MAP, CrmWriteModuleDef } from './crm-write.module-map';
import { VALID_CUSTOM_FIELD_MODULES } from '../native-crm/custom-fields/custom-field-definition.validator';
import { DataScope } from '../../types';
import { applyDataScopeToFilter, applyDataScopeToCreatedByFilter } from '../native-crm/shared/data-scope';
import { getFieldCatalog } from '../native-crm/automation-rules/automation-rule.service';
import { PipelineModule, BuiltInPipelineModule } from '../native-crm/pipeline-config/pipeline-config.model';
import { ITargetFieldDef, BUILT_IN_TARGET_FIELDS } from '../native-crm/automation-rules/target-field-catalog';
import { transformPIIResponse } from '../../platform/pii/pii.service';
import { PII_FIELDS } from '../../platform/pii/constants';
import { getSettings } from '../native-crm/fs-settings/fs-settings.service';
import { listCustomFields } from '../native-crm/custom-fields/custom-field.service';

/** Modules whose schema getFieldCatalog() already covers — everything else
 * in CRM_WRITE_MODULE_MAP gets its schema from its own hand-authored
 * `schemaFields` allowlist instead (see that file's own comment on why:
 * extending getFieldCatalog()'s BuiltInPipelineModule type would touch the
 * automation engine for a reason unrelated to automations). */
const FIELD_CATALOG_MODULES = new Set<BuiltInPipelineModule>(['lead', 'deal', 'workorder', 'invoice', 'task', 'ticket']);

/** Counting reuses each module's own `list()` function (limit:1, read
 * .total) — deliberately NOT a separate `countDocuments` call. `list` is
 * the exact same function the module's own human-facing list screen
 * already calls, so whatever filtering that screen applies today (active/
 * archived flags, branch scoping, anything not independently re-verified
 * per module here) is automatically inherited by the chatbot's count,
 * rather than risking a second, hand-written filter drifting out of sync
 * with the real one. */
export async function countCrmModule(
  module: string, tenantId: string, scope: DataScope, branchId?: string | null,
  /** Already-validated list() filter options (status / range:'exact' +
   * dateFrom/dateTo/dateField) from parseCrmReadFilters — optional, so a
   * caller that passes none gets the same unfiltered count as before. */
  filterOpts?: Record<string, unknown>,
  /** The caller's userId — passed to list() like GET /crm-list does. */
  userId?: string,
): Promise<{ total: number } | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return null;
  const result = await def.list(tenantId, { ...(filterOpts ?? {}), limit: 1, page: 1 } as any, branchId, scope, userId);
  return { total: result.total };
}

/** The one deliberate exception to "always reuse list()" — "overdue" isn't
 * exposed through any module's existing list() options today. Mirrors the
 * exact shape Task/WorkOrder/Ticket's own getXStats() functions already use
 * for this (confirmed by reading them): a date field in the past AND status
 * not in a terminal set, scoped via the SAME applyDataScopeToFilter/
 * applyDataScopeToCreatedByFilter helpers those stats functions already
 * call — never a third, independent implementation of DataScope filtering. */
export async function getOverdueCrmModule(
  module: string, tenantId: string, scope: DataScope,
  options?: { includeItems?: boolean; limit?: number; branchId?: string | null; role?: string },
): Promise<{ count: number; items?: any[] } | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def?.overdueConfig || !def.model) return null;

  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  // Same branch scoping the module's own list()/stats() apply (Work Order,
  // Task and Ticket all carry branchId) — without it a branch user's
  // overdue count covered every branch while their list did not.
  if (options?.branchId) filter.branchId = new mongoose.Types.ObjectId(options.branchId);
  if (def.overdueConfig.scopeAnchor === 'staffIds') {
    applyDataScopeToFilter(filter, scope, 'staffIds');
  } else {
    applyDataScopeToCreatedByFilter(filter, scope);
  }

  const terminalStatuses = typeof def.overdueConfig.terminalStatuses === 'function'
    ? await def.overdueConfig.terminalStatuses(tenantId)
    : def.overdueConfig.terminalStatuses;

  filter[def.overdueConfig.dateField] = { $lt: new Date() };
  filter[def.statusField ?? 'status'] = { $nin: terminalStatuses };

  // Same filter object for both queries — never a second, divergent filter
  // construction for "the list" vs "the count."
  if (!options?.includeItems) {
    const count = await def.model.countDocuments(filter);
    return { count };
  }
  const [count, rawItems] = await Promise.all([
    def.model.countDocuments(filter),
    def.model.find(filter).sort({ [def.overdueConfig.dateField]: 1 }).limit(Math.min(options.limit ?? 10, 25)),
  ]);
  const piiSafe = await applyPIIProtection(rawItems, def.logModule, tenantId, options.branchId, options.role ?? 'AGENT');
  const items = projectForRead(piiSafe, def);
  return { count, items };
}

/** Applies the SAME PII decrypt/mask step every human-facing controller for
 * a PII_FIELDS-registered module (leads/customers/contacts/staffs/sites)
 * already calls on its own list/getOne results — found missing here during
 * Stage A live verification: GET /crm-list calls `moduleDef.list()` (the
 * module's service function) directly, bypassing the controller entirely,
 * so Level 2/3 PII fields (email/phone/address/etc.) rode through to the AI
 * service as raw ciphertext instead of being decrypted-for-admins or
 * masked-for-everyone-else like the real UI does. Mirrors each controller's
 * own `getPIIViewRoles` helper (tenant fs-settings piiConfig for that
 * module) rather than reimplementing the lookup. A no-op for any module not
 * in PII_FIELDS (most of Stage A's modules have no registered PII fields at
 * all). Affects lead (Phase 1) too — same gap, same fix. */
export async function applyPIIProtection(
  items: any[], logModule: string, tenantId: string, branchId: string | null | undefined, role: string,
): Promise<any[]> {
  if (!PII_FIELDS[logModule]) return items;
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  const viewRoles: string[] = (settings as any)?.piiConfig?.find((p: any) => p.module === logModule)?.viewRoles ?? [];
  return transformPIIResponse(items, logModule, role, viewRoles);
}

/** Projects raw list()/search results down to a module's own `schemaFields`
 * allowlist before they ever leave this service — closes a real gap found
 * during Stage A live verification: `schemaFields` only governed what
 * getCrmModuleSchema() described and what the prompt told the model to
 * mention, but GET /crm-list returned each item's full Mongoose document
 * unfiltered, so a credential-adjacent field with no `select: false`
 * (Staff/Customer's `appUsername`, `appCredentialsGeneratedAt`,
 * `appLastLoginAt` — real mobile-app login identifiers, not secrets
 * themselves, but still never meant to reach a third-party LLM provider)
 * rode along into the AI service's tool-result payload regardless of what
 * the final chat response said. Only applied to modules with `schemaFields`
 * declared — the 5 getFieldCatalog()-covered modules (lead/workorder/
 * invoice/task/ticket) are untouched, exactly as Phase 1 already
 * live-verified them. `_id` is always kept (an opaque identifier, needed by
 * any future write-side follow-up — Stage A itself never writes). */
export function projectToSchemaFields(items: any[], schemaFields: ITargetFieldDef[]): Record<string, unknown>[] {
  const keys = schemaFields.map((f) => f.key);
  return items.map((item) => {
    const doc = typeof item.toObject === 'function' ? item.toObject() : item;
    const projected: Record<string, unknown> = { _id: doc._id };
    for (const key of keys) {
      if (key in doc) projected[key] = doc[key];
    }
    return projected;
  });
}

/** Keys that must never leave the gateway, whatever a dynamic field list
 * (getFieldCatalog / custom fields) might say — a second safety layer on
 * top of the hand-authored allowlists. Any key starting with 'utm' is
 * forbidden as well (see isForbiddenReadKey). */
export const READ_FORBIDDEN_KEYS = new Set([
  'portalToken', 'signatureUrl', 'tenantId', 'branchId', '__v',
  'isLocked', 'lockedAt', 'lockedBy', 'lockReason',
  'createdBy', 'updatedBy',
  'emailSearch', 'phoneSearch', 'emailDomain',
  'chatSessionId', 'conversationSummary', 'photos', 'location',
  // CRM-assistant reminder-pause markers (shared/assistant-provenance.ts):
  // server bookkeeping, never shown to or round-tripped by the assistant.
  'assistantChangedAt', 'assistantFingerprint', 'reminderSuppressedAt',
]);

export function isForbiddenReadKey(key: string): boolean {
  return READ_FORBIDDEN_KEYS.has(key) || /^utm/i.test(key);
}

/** Keys the assistant can never write, on create or update (C6). */
export const WRITE_FORBIDDEN_KEYS = new Set([
  'tenantId', 'branchId', 'createdBy', 'updatedBy', '_id', '__v',
  'isLocked', 'lockedAt', 'lockedBy', 'lockReason', 'portalToken', 'numId',
  // Set only server-side, by the gateway's own write context
  // (runAsAssistantWrite) and the reminder cron's bookkeeping. The assistant
  // can never set or clear them.
  'assistantChangedAt', 'assistantFingerprint', 'reminderSuppressedAt',
]);

/** Money values the invoice, quotation and contract services COMPUTE
 * themselves, never take from a chat write: partsAmount, servicesAmount and
 * servicesAmountWithTax from the line items, discount and GST (create and
 * update); paidAmount and paid from the invoice's receipts (getInvoiceById,
 * receipt.service.ts); balanceDue is an invoice virtual. Work orders store
 * no total. Some of these are in the automation field catalog, so they would
 * otherwise be writable, and an update that leaves the lines alone saves a
 * sent servicesAmount as is. Chat writes only: the screens are unchanged. */
export const COMPUTED_MONEY_WRITE_KEYS = new Set([
  'partsAmount', 'servicesAmount', 'servicesAmountWithTax', 'paidAmount', 'paid', 'balanceDue',
]);

/** Fields that appear in a module's schemaFields (so the assistant may READ
 * them) but are server-generated and must not be WRITTEN: Customer's
 * customerId is the business id set by the model's pre-save hook, and work
 * orders/invoices reference it — overwriting it would orphan them. Team's
 * managerUserId and Staff's teamId decide who can see which records
 * (DataScope), so the assistant never changes them either (D28). */
const SCHEMA_FIELD_WRITE_EXCLUSIONS: Record<string, string[]> = {
  customer: ['customerId'],
  activity: ['activityId'],
  team: ['managerUserId'],
  staff: ['teamId'],
};

/** Custom-field types that cannot hold a plain value (mirrors
 * automation-rule.service.ts's UNMAPPABLE_NATIVE_CUSTOM_FIELD_TYPES). */
const UNWRITABLE_CUSTOM_FIELD_TYPES = new Set(['image', 'images', 'video', 'videos', 'custom_form']);

/** The custom-field module key for a registry module — the PLURAL key
 * custom fields are stored under (VALID_CUSTOM_FIELD_MODULES), which is the
 * module's logModule ('workorder' -> 'workorders'). Undefined for an
 * unknown module or one custom fields don't support. */
export function customFieldModuleKey(module: string): string | undefined {
  const key = CRM_WRITE_MODULE_MAP[module]?.logModule;
  return key && VALID_CUSTOM_FIELD_MODULES.has(key) ? key : undefined;
}

/** The fields a module's list/overdue/today results may carry: its
 * schemaFields keys (13 modules, unchanged) or its readFields allowlist
 * (lead/workorder/invoice/task/ticket). */
export function readFieldKeysFor(module: string): string[] {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return [];
  if (def.schemaFields) return def.schemaFields.map((f) => f.key);
  return (def.readFields ?? []).filter((k) => !isForbiddenReadKey(k));
}

function toPlain(item: any): Record<string, any> {
  if (!item || typeof item !== 'object') return {};
  return typeof item.toObject === 'function' ? item.toObject() : item;
}

/** A plain key/value object — not an array, Date, ObjectId or Buffer. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId || Buffer.isBuffer(value)) return false;
  if ((value as { _bsontype?: unknown })._bsontype) return false;
  return true;
}

function projectValue(key: string, value: unknown, nested?: Record<string, string[]>): unknown {
  const subKeys = nested?.[key];
  if (!subKeys || !isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const sub of subKeys) if (sub in value) out[sub] = (value as Record<string, unknown>)[sub];
  return out;
}

/** Projects one document down to `_id` + the given keys (in that order),
 * applying the module's nestedProjection to populated references. */
export function projectDocument(item: any, keys: string[], nested?: Record<string, string[]>): Record<string, unknown> {
  const doc = toPlain(item);
  const projected: Record<string, unknown> = { _id: doc._id };
  for (const key of keys) {
    if (key === '_id') continue;
    if (key in doc) projected[key] = projectValue(key, doc[key], nested);
  }
  return projected;
}

/** C5 list/overdue/today projection for any registry module. */
export function projectForRead(items: any[], def: CrmWriteModuleDef): Record<string, unknown>[] {
  const keys = def.schemaFields
    ? def.schemaFields.map((f) => f.key)
    : (def.readFields ?? []).filter((k) => !isForbiddenReadKey(k));
  return items.map((item) => projectDocument(item, keys, def.nestedProjection));
}

/** C4 /crm-get projection: the read allowlist UNION the module's writable
 * fields (the write path's diff/stale check needs every writable field),
 * minus anything forbidden. Writable custom fields (customFields.<key>)
 * come back as a `customFields` object holding only those keys. */
export function projectForDetail(item: any, def: CrmWriteModuleDef, writableKeys: string[]): Record<string, unknown> {
  const base = def.schemaFields
    ? def.schemaFields.map((f) => f.key)
    : (def.readFields ?? []).filter((k) => !isForbiddenReadKey(k));
  const plainWritable = writableKeys.filter((k) => !k.startsWith('customFields.') && !isForbiddenReadKey(k));
  const customKeys = writableKeys.filter((k) => k.startsWith('customFields.')).map((k) => k.slice('customFields.'.length));
  const keys = [...new Set([...base, ...plainWritable])];
  const projected = projectDocument(item, keys, def.nestedProjection);
  if (customKeys.length > 0) {
    const doc = toPlain(item);
    const source = isPlainObject(doc.customFields) ? doc.customFields : {};
    const customFields: Record<string, unknown> = {};
    for (const key of customKeys) if (key in source) customFields[key] = source[key];
    projected.customFields = customFields;
  }
  return projected;
}

/** C6: every key the assistant may write for this module (create AND
 * update) — schemaFields keys for the 13 hand-authored modules,
 * getFieldCatalog() keys for lead/workorder/invoice/task/ticket, plus
 * `customFields.<key>` for the caller's own custom fields on this module
 * (listCustomFields with the PLURAL key and the caller's branch — the same
 * list GET /crm-schema shows, so what the assistant is told it can fill in
 * and what it is allowed to write always agree). System keys are never
 * included. */
export async function getWritableFieldKeys(module: string, tenantId: string, branchId?: string | null): Promise<string[]> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return [];
  const keys = new Set<string>();

  if (FIELD_CATALOG_MODULES.has(module as BuiltInPipelineModule)) {
    const catalog = await getFieldCatalog(tenantId, module as PipelineModule);
    catalog.forEach((f) => keys.add(f.key));
  } else {
    const excluded = new Set(SCHEMA_FIELD_WRITE_EXCLUSIONS[module] ?? []);
    (def.schemaFields ?? []).forEach((f) => { if (!excluded.has(f.key)) keys.add(f.key); });
  }

  const cfModule = customFieldModuleKey(module);
  if (cfModule) {
    const customFieldDocs = await listCustomFields(tenantId, cfModule, branchId ?? null);
    customFieldDocs
      .filter((f: any) => !UNWRITABLE_CUSTOM_FIELD_TYPES.has(f.fieldType))
      .forEach((f: any) => keys.add(`customFields.${f.fieldKey}`));
  }

  return [...keys].filter((k) => !WRITE_FORBIDDEN_KEYS.has(k) && !COMPUTED_MONEY_WRITE_KEYS.has(k));
}

/** The same fields as getWritableFieldKeys, with their labels, read without
 * side effects: the built-in catalog modules take their keys from
 * BUILT_IN_TARGET_FIELDS directly instead of getFieldCatalog(), whose stage
 * lookup can create a PipelineConfig document (the stage options are the
 * only thing it adds), plus the tenant-wide custom fields getFieldCatalog()
 * lists. For the CRM assistant's staged operations
 * (crm-assistant/operations/validate.ts), which must write nothing before
 * Confirm. */
export async function getWritableFieldDefs(
  module: string, tenantId: string, branchId?: string | null,
): Promise<Array<{ key: string; label: string }>> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return [];
  const fields = new Map<string, { key: string; label: string }>();
  const cfModule = customFieldModuleKey(module);
  const addCustom = (docs: any[]) => docs
    .filter((f: any) => !UNWRITABLE_CUSTOM_FIELD_TYPES.has(f.fieldType))
    .forEach((f: any) => fields.set(`customFields.${f.fieldKey}`, { key: `customFields.${f.fieldKey}`, label: String(f.label ?? f.fieldKey) }));

  if (FIELD_CATALOG_MODULES.has(module as BuiltInPipelineModule)) {
    (BUILT_IN_TARGET_FIELDS[module as BuiltInPipelineModule] ?? []).forEach((f) => fields.set(f.key, { key: f.key, label: f.label }));
    if (cfModule) addCustom(await listCustomFields(tenantId, cfModule));
  } else {
    const excluded = new Set(SCHEMA_FIELD_WRITE_EXCLUSIONS[module] ?? []);
    (def.schemaFields ?? []).forEach((f) => { if (!excluded.has(f.key)) fields.set(f.key, { key: f.key, label: f.label }); });
  }
  if (cfModule) addCustom(await listCustomFields(tenantId, cfModule, branchId ?? null));

  return [...fields.values()].filter((f) => !WRITE_FORBIDDEN_KEYS.has(f.key) && !COMPUTED_MONEY_WRITE_KEYS.has(f.key));
}

/** Returns every key in `data` the assistant may not write: system keys
 * (WRITE_FORBIDDEN_KEYS), computed money values (COMPUTED_MONEY_WRITE_KEYS)
 * and anything outside `writable`. A nested `customFields` object is checked
 * key by key; a dotted `customFields.<key>` is checked as-is. */
export function findDisallowedWriteKeys(data: Record<string, unknown>, writable: Iterable<string>): string[] {
  const allowed = new Set(writable);
  const bad: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (WRITE_FORBIDDEN_KEYS.has(key) || COMPUTED_MONEY_WRITE_KEYS.has(key)) { bad.push(key); continue; }
    if (key === 'customFields') {
      if (!isPlainObject(value)) { bad.push(key); continue; }
      for (const sub of Object.keys(value)) {
        if (!allowed.has(`customFields.${sub}`)) bad.push(`customFields.${sub}`);
      }
      continue;
    }
    if (!allowed.has(key)) bad.push(key);
  }
  return bad;
}

/** Returns every key in `data` whose value is a list or an object, for keys
 * outside custom fields. Every built-in field the assistant may write holds
 * one value: text, a number, a date, true/false or one option (the field
 * types of schemaFields and of the automation field catalog). So a list or an
 * object there is never valid. It is not harmless either: Mongoose stores
 * `{ _id: 'text' }` in a text field as 'text'. Custom fields keep their own
 * checks: a `customFields` object and `customFields.<key>` values (some
 * custom field types hold a list) are not looked at here. */
export function findNonScalarWriteValues(data: Record<string, unknown>): string[] {
  return Object.entries(data)
    .filter(([key, value]) => key !== 'customFields' && !key.startsWith('customFields.')
      && value !== null && typeof value === 'object' && !(value instanceof Date))
    .map(([key]) => key);
}

/** Keys that hold a percentage: the discount and GST rate of an invoice,
 * quotation, contract or work order (the services compute the totals from
 * them; discount is a percentage, not an amount). */
const PERCENT_WRITE_KEYS = ['discount', 'gstPercentage'];

/** Returns every percentage key in `data` whose value is not a number from 0
 * to 100. A numeric string counts as its number (Mongoose casts it); null,
 * an empty string, true/false or anything else is refused. */
export function findOutOfRangePercentValues(data: Record<string, unknown>): string[] {
  return PERCENT_WRITE_KEYS.filter((key) => {
    if (!(key in data) || data[key] === undefined) return false;
    const raw = data[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return !Number.isFinite(n) || n < 0 || n > 100;
  });
}

export interface CrmModuleSchemaResult {
  module: string;
  fields: ITargetFieldDef[];
  /** True when this came from the automation engine's own field catalog
   * (lead/workorder/invoice/task/ticket) rather than this file's
   * hand-authored allowlist — informational only, lets a caller note the
   * source if useful, never changes the shape returned. */
  fromAutomationCatalog: boolean;
  /** Tenant-defined extra fields on this BUILT-IN module (the separate
   * Custom Fields system, native-crm/custom-fields/ — NOT Custom Modules,
   * a different, unrelated system for whole new tenant-defined objects).
   * Deliberately a SEPARATE array from `fields` above, never merged in —
   * the two systems have genuinely different type sets (5 fixed types for
   * native fields vs. 19 real Custom Field types) and keeping them visibly
   * distinct in this response is what lets a caller (or the AI prompt)
   * never conflate the two. Always present (possibly empty), never
   * undefined, so a caller never has to guess whether "no custom fields"
   * means "none exist" vs. "wasn't checked". */
  customFields: Array<{ id: string; key: string; label: string; fieldType: string; required: boolean; options?: string[] }>;
}

/** Schema introspection — getFieldCatalog() for the 5 modules it already
 * covers (lead/workorder/invoice/task/ticket — the automation engine's own
 * BuiltInPipelineModule values), each module's own hand-authored
 * `schemaFields` allowlist otherwise. Never a raw Mongoose-schema
 * reflection — see crm-write.module-map.ts's own comment on why (keeping
 * credential/internal-only fields, e.g. Staff's app-login fields,
 * impossible to expose even by accident). */
export async function getCrmModuleSchema(
  module: string, tenantId: string,
  /** Optional — when provided, Custom Fields are scoped to this branch (or
   * tenant-wide when null/omitted), matching listCustomFields' own strict
   * per-branch isolation. Omitted entirely by any pre-existing caller that
   * doesn't pass it, which resolves to tenant-wide (branchId: null) —
   * identical to today's behavior for every field that already existed
   * before this parameter was added. */
  branchId?: string | null,
): Promise<CrmModuleSchemaResult | null> {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return null;

  // Custom fields are stored under the PLURAL module key ('workorders',
  // 'leads', ... — VALID_CUSTOM_FIELD_MODULES), which is exactly the
  // module's logModule. Querying the singular registry key ('workorder')
  // matched nothing, so customFields always came back empty.
  // A module custom fields can't attach to (Supervisors) has none to list.
  const cfModule = customFieldModuleKey(module);
  const customFieldDocs = cfModule ? await listCustomFields(tenantId, cfModule, branchId ?? null) : [];
  const customFields = customFieldDocs.map((f: any) => ({
    id: String(f._id), key: f.fieldKey, label: f.label, fieldType: f.fieldType, required: !!f.required, options: f.options,
  }));

  if (FIELD_CATALOG_MODULES.has(module as BuiltInPipelineModule)) {
    const fields = await getFieldCatalog(tenantId, module as PipelineModule);
    return { module, fields, fromAutomationCatalog: true, customFields };
  }

  return { module, fields: def.schemaFields ?? [], fromAutomationCatalog: false, customFields };
}
