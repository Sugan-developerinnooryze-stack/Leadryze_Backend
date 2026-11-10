import { CRM_WRITE_MODULE_MAP } from '../../internal/crm-write.module-map';
import { applyPIIProtection, customFieldModuleKey } from '../../internal/crm-read.service';
import { getAllSettingsDefaults, getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { listCustomFields } from '../../native-crm/custom-fields/custom-field.service';
import type { CustomFieldType } from '../../native-crm/custom-fields/custom-field.model';
import { isValidTimeZone, parseIsoCalendarDate } from '../../native-crm/shared/date-range';
import { isMaskedPiiValue } from '../../native-crm/shared/pii-update';
import { dayKeyFor, isServerMidnight, localDateKey, serverLocalDateKey } from '../../daily-events/daily-events.time';
import { ADMIN_ROLES, PII_FIELDS } from '../../../platform/pii/constants';
import { isEncrypted } from '../../../utils/crypto';
import { logger } from '../../../utils/logger';
import type { DataScope } from '../../../types';
import { FieldKeySchema } from '../contracts/plan';
import type { DateExpr, DateTimeExpr, WriteValue } from '../contracts/plan';
import type { FormRefValue, FormValue } from '../contracts/views';
import type { AssistIdentity } from '../identity';
import { resolveScopeForIdentity } from '../gates';
import type { GatewayTenant } from '../gates';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteCap, WriteFieldKind, WriteFormField, WriteOp } from '../registry/types';
import { gateRelated } from '../query/relations';
import type { RelatedGate } from '../query/relations';
import { isObjectIdText, ownStaffIdFor, schemaEnumValues, scopedFind, scopedFindById } from '../query/scoped-match';
import { dateExprToKey } from '../query/compile';
import { utcToWallTime } from '../grammar/wall-time';
import { humanize } from '../views/chips';
import { looksMasked } from './validate';
import { canPickUsers, crmUserRef } from './crm-users';
import type {
  CustomFieldDef, FieldNote, FillField, FillFormSpec, FormContext, FormOrigin, PrefillSource, StageOption, StoredRef, StoredRefValue,
  WorkflowModule,
} from '../writes/workflow-types';

/* What a guided form starts from (Increment 6, B-PREFILL): the caller's
 * form context (reads only: zone, scope, PII visibility, own staff and user,
 * stage and enum options, custom fields, Field Service defaults), the fields
 * of a form, a create's defaults, the address prefill (D29, L29), a record's
 * values for an update form with PII masked (L10), and the conversions
 * between a message's write values and the form's values.
 *
 * Nothing here writes: stages come from peekStages, settings from getSettings
 * and getAllSettingsDefaults; getOrCreateStages, isValidStageKey,
 * getOutcomeStageKey, getFieldCatalog, getStatusOptions, upsertSettings and
 * nextClientId are never called (they can create documents). Every other
 * module is read under its own gates and scope (gateRelated). A PII value the
 * caller may not view is never copied into a form (D29). */

/** B20: the address help when the customer's address is hidden for the caller's role. */
export const ADDRESS_HIDDEN = "This customer's address is hidden for your role. Type the site address.";
/** Increment 7 (B12): an invoice's address is its billing address. */
const INVOICE_ADDRESS_HIDDEN = "This customer's address is hidden for your role. Type the billing address.";

/** The address help of a module's form when the customer's address is hidden. */
function addressHiddenHint(module: string): string {
  return module === 'invoice' ? INVOICE_ADDRESS_HIDDEN : ADDRESS_HIDDEN;
}

/** The work order's document address, the one field the address prefill fills. */
const ADDRESS_KEY = 'address';
/** The customer address parts a prefill joins, as the work order screen composes them (WorkordersPage.tsx autofillComposeKeys). */
const CUSTOMER_ADDRESS_PARTS = ['address', 'city', 'state', 'postcode', 'country'] as const;

/** Custom-field types that can't hold a plain value (the same list as
 * crm-read.service.ts UNWRITABLE_CUSTOM_FIELD_TYPES, which isn't exported):
 * never a form field; a required one can only be filled on its page. */
const UNWRITABLE_CUSTOM_FIELD_TYPES: ReadonlySet<string> = new Set(['image', 'images', 'video', 'videos', 'custom_form']);

/** A custom field's form kind by its type (spec B10). */
const CUSTOM_FIELD_KINDS: Readonly<Partial<Record<CustomFieldType, WriteFieldKind>>> = {
  text: 'text', url: 'text', textarea: 'longtext', number: 'number', rating: 'number', currency: 'money',
  checkbox: 'boolean', boolean: 'boolean', dropdown: 'enum', radio: 'enum', multi_select: 'multiselect',
  date: 'date', datetime: 'datetime', email: 'email', phone: 'phone',
};

const CUSTOM_GROUP = 'More fields';
const MAX_FORM_FIELDS = 40;
const CUSTOM_PREFIX = 'customFields.';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), record);
}

/** A value of the record as shown: "customFields.<key>" reads the custom-fields object (or Map). */
function shownValueOf(record: Record<string, unknown>, key: string): unknown {
  if (!key.startsWith(CUSTOM_PREFIX)) return record[key];
  const custom = record.customFields;
  const sub = key.slice(CUSTOM_PREFIX.length);
  return custom instanceof Map ? custom.get(sub) : custom && typeof custom === 'object' ? (custom as Record<string, unknown>)[sub] : undefined;
}

/** An ObjectId (or its text) as lower-case hex; null for anything else. */
function hexOf(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value);
  return isObjectIdText(text) ? text.toLowerCase() : null;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/* ── Form context ──────────────────────────────────────────────────────── */

/** piiConfig[piiModule].viewRoles of a settings document (fs-settings), as applyPIIProtection reads them. */
function viewRolesOf(settings: unknown, piiModule: string): string[] {
  const config = (settings as { piiConfig?: unknown } | null | undefined)?.piiConfig;
  const entry = Array.isArray(config) ? config.find((p) => (p as { module?: unknown } | null)?.module === piiModule) : undefined;
  const roles = (entry as { viewRoles?: unknown } | undefined)?.viewRoles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

/** The modules a form's references read: ref and ref_many targets, and a related field's modules. */
function referencedModules(fields: readonly WriteFormField[]): string[] {
  const modules = new Set<string>();
  for (const field of fields) {
    if ((field.kind === 'ref' || field.kind === 'ref_many') && field.ref) modules.add(field.ref.module);
    if (field.kind === 'related' && field.related) field.related.modules.forEach((m) => modules.add(m));
  }
  return [...modules];
}

/** The tenant's active stages of a pipeline, by order (peekStages: never creates a pipeline), less the ones the
 * field never offers (stageExclude: an invoice's paid stage, by its outcome tag or its key). */
async function activeStages(tenantId: string, field: WriteFormField): Promise<StageOption[]> {
  if (field.options?.from !== 'pipeline') return [];
  const stages = await peekStages(tenantId, field.options.pipeline);
  const exclude = field.stageExclude;
  const excluded = (s: { key: string; outcome?: string | null }) =>
    !!exclude && (exclude.keys.includes(s.key) || (typeof s.outcome === 'string' && exclude.outcomes.includes(s.outcome)));
  return (Array.isArray(stages) ? stages : [])
    .filter((s) => s?.isActive === true && typeof s.key === 'string' && s.key !== '' && !excluded(s))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({
      key: s.key, label: typeof s.label === 'string' && s.label ? s.label : humanize(s.key),
      ...(typeof s.color === 'string' && s.color ? { color: s.color } : {}), terminal: s.isTerminal === true,
    }));
}

/** L16: the preferred key when it is an active stage, else the first active
 * stage that isn't terminal, else the first active one. */
function stageDefaultOf(options: readonly StageOption[], preferred: string | undefined): string | null {
  if (preferred && options.some((o) => o.key === preferred)) return preferred;
  return options.find((o) => !o.terminal)?.key ?? options[0]?.key ?? null;
}

/** An enum's values: the model's own enum at the key (the registry's
 * introspected schema, else the Mongoose path), or the field's static list. */
function enumValuesOf(module: string, field: WriteFormField): string[] {
  const source = field.options;
  if (!source || source.from === 'pipeline') return [];
  if (source.from === 'static') return source.values.filter((v) => typeof v === 'string' && v !== '');
  const cap = getModuleCap(module);
  if (!cap) return [];
  const known = cap.fields.find((f) => !f.virtual && (f.path === field.key || f.key === field.key))?.schema?.enumValues;
  return (known?.length ? [...known] : schemaEnumValues(cap, field.key)).filter((v) => typeof v === 'string' && v !== '');
}

/** The tenant's custom fields of the module for the caller's branch (strict
 * per branch, as the screens list them). A field whose type can't hold a plain
 * value, or whose key can't be a form key, is kept as not writable. */
async function customFieldsFor(cap: WriteCap, tenantId: string, branchId: string | null): Promise<CustomFieldDef[]> {
  const cfModule = cap.customFields ? customFieldModuleKey(cap.module) : undefined;
  if (!cfModule) return [];
  const docs: unknown = await listCustomFields(tenantId, cfModule, branchId);
  const out: CustomFieldDef[] = [];
  for (const doc of Array.isArray(docs) ? docs as Array<Record<string, unknown>> : []) {
    const fieldKey = typeof doc?.fieldKey === 'string' ? doc.fieldKey : '';
    if (!fieldKey) continue;
    const key = `${CUSTOM_PREFIX}${fieldKey}`;
    const type = doc.fieldType as CustomFieldType;
    out.push({
      key, fieldKey,
      label: typeof doc.label === 'string' && doc.label.trim() ? doc.label.trim() : fieldKey,
      type,
      options: Array.isArray(doc.options) ? doc.options.filter((o): o is string => typeof o === 'string' && o !== '') : [],
      required: doc.required === true,
      writable: !UNWRITABLE_CUSTOM_FIELD_TYPES.has(type) && !!CUSTOM_FIELD_KINDS[type] && FieldKeySchema.safeParse(key).success,
    });
  }
  return out;
}

/** The branch's Field Service discount and GST defaults: the caller's branch
 * entry, else the organisation's (an inactive or unknown branch has none). */
async function fsDefaultsFor(tenantId: string, branchId: string | null): Promise<{ discount: number; gst: number } | null> {
  const entries = await getAllSettingsDefaults(tenantId);
  const list = Array.isArray(entries) ? entries : [];
  const entry = (branchId ? list.find((e) => e.branchId === branchId) : undefined) ?? list.find((e) => e.branchId === null);
  if (!entry) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { discount: num(entry.discountPercentage), gst: num(entry.taxPercentage) };
}

/** The first non-empty group of the module's title fields ("Ravi Kumar"), else its singular label. */
function nameOf(cap: ModuleCap, row: Record<string, unknown>): string {
  for (const group of cap.ids.title) {
    const parts = group.split(/[\s+]+/).filter(Boolean)
      .map((path) => getPath(row, path))
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '' && !isObjectIdText(v.trim()))
      .map((v) => v.trim());
    if (parts.length) return clip(parts.join(' '), 200);
  }
  return cap.labels.singular;
}

/** The caller's own staff record, read through the staff module's gates and
 * scope: null when they have none, or can't see it. */
async function ownStaffFor(gate: RelatedGate): Promise<StoredRef | null> {
  const side = await gate('staff');
  if (!side.ok) return null;
  const staffId = await ownStaffIdFor(side.ctx);
  if (!staffId) return null;
  const [row] = await scopedFind(side.cap, side.ctx, [{ staffId }], { sort: { _id: 1 }, skip: 0, limit: 1 });
  const id = row ? hexOf(row._id) : null;
  return row && id ? { module: 'staff', id, key: staffId, label: nameOf(side.cap, row) } : null;
}

/** Everything a form needs to know about its caller, read once per request
 * (spec B10), the reads run side by side. A failed settings, stage, default
 * or own-record read degrades (PII hidden, no default); a failed scope,
 * custom-field or gate read rejects. */
export async function loadFormContext(wf: WorkflowModule, op: WriteOp, caller: { identity: AssistIdentity; tenant: GatewayTenant; now?: Date },
  opts?: { scope?: DataScope }): Promise<FormContext> {
  const { identity, tenant } = caller;
  const now = caller.now ?? new Date();
  const tenantId = identity.tenantId;
  const branchId = identity.branchId ?? null;
  const cap = wf.cap;
  const def = Object.prototype.hasOwnProperty.call(CRM_WRITE_MODULE_MAP, cap.module) ? CRM_WRITE_MODULE_MAP[cap.module] : undefined;
  if (!def) throw new Error(`No gateway module for "${cap.module}"`);
  const timezone = isValidTimeZone(tenant.timezone) ? tenant.timezone : 'UTC';
  const gate = gateRelated({ identity, tenant, now });
  const fields = cap.fields;
  const needsUsers = fields.some((f) => f.kind === 'owner_user');
  const needsStaff = fields.some((f) => (f.kind === 'ref' || f.kind === 'ref_many') && f.ref?.module === 'staff');
  const needsFsDefaults = op === 'create' && fields.some((f) => f.default?.kind === 'fs_discount' || f.default?.kind === 'fs_gst');
  const stageFields = fields.filter((f) => f.kind === 'stage');
  // A document's line modules too (Increment 7): refAccess.service says whether the caller can read the catalog.
  const modules = [...new Set([...referencedModules(fields), ...(cap.lines?.add ?? [])])];

  const [scope, settings, canPick, ownStaff, ownUser, stageLists, customFields, fsDefaults, access] = await Promise.all([
    opts?.scope ? Promise.resolve(opts.scope) : resolveScopeForIdentity(tenantId, identity, def.logModule, tenant.dataScopeConfig),
    getSettings(tenantId, branchId).catch(() => null) as Promise<unknown>,
    needsUsers ? canPickUsers(tenantId, identity).catch(() => false) : Promise.resolve(false),
    needsStaff ? ownStaffFor(gate).catch(() => null) : Promise.resolve(null),
    needsUsers ? crmUserRef(tenantId, identity.userId).catch(() => null) : Promise.resolve(null),
    Promise.all(stageFields.map((f) => activeStages(tenantId, f).catch(() => []))),
    // A delete has no form: its custom fields are never shown or checked.
    op === 'delete' ? Promise.resolve([]) : customFieldsFor(cap, tenantId, branchId),
    needsFsDefaults ? fsDefaultsFor(tenantId, branchId).catch(() => null) : Promise.resolve(null),
    Promise.all(modules.map((m) => gate(m))),
  ]);

  // The role string decides, as applyPIIProtection decides it (never roleId).
  const admin = ADMIN_ROLES.includes(identity.role);
  const sees = (piiModule: string) => admin || viewRolesOf(settings, piiModule).includes(identity.role);
  const stageOptions: Record<string, readonly StageOption[]> = {};
  const stageDefaults: Record<string, string | null> = {};
  stageFields.forEach((field, i) => {
    stageOptions[field.key] = stageLists[i];
    stageDefaults[field.key] = stageDefaultOf(stageLists[i], field.default?.kind === 'stage' ? field.default.preferred : undefined);
  });
  const enumOptions: Record<string, readonly string[]> = {};
  for (const field of fields) if (field.kind === 'enum' || field.kind === 'multiselect') enumOptions[field.key] = enumValuesOf(cap.module, field);
  for (const custom of customFields) {
    const kind = CUSTOM_FIELD_KINDS[custom.type];
    if (custom.writable && (kind === 'enum' || kind === 'multiselect')) enumOptions[custom.key] = custom.options;
  }
  const refAccess: Record<string, FormContext['refAccess'][string]> = {};
  modules.forEach((module, i) => { const side = access[i]; refAccess[module] = side.ok ? 'ok' : side.reason; });
  const s = (settings ?? {}) as { currency?: unknown; defaultDurationHours?: unknown; staffHardBlock?: unknown };
  const duration = typeof s.defaultDurationHours === 'number' ? s.defaultDurationHours : NaN;

  return {
    module: cap.module, op,
    timezone, todayKey: localDateKey(now, timezone), now,
    scope,
    // A module without registered PII has nothing to hide (reviewReadContext's rule).
    piiVisible: !PII_FIELDS[def.logModule] || sees(def.logModule),
    customerPiiVisible: sees('customers'),
    sitePiiVisible: sees('sites'),
    canPickUsers: canPick,
    ownStaff,
    ownUser: ownUser ?? { module: 'user', id: identity.userId, key: identity.userId, label: 'You' },
    stageOptions, stageDefaults, enumOptions,
    customFields,
    fsDefaults,
    defaultDurationHours: Number.isFinite(duration) && duration > 0 ? duration : null,
    staffHardBlock: s.staffHardBlock === true,
    branchCurrency: typeof s.currency === 'string' && s.currency.trim() ? s.currency.trim() : 'INR',
    refAccess,
  };
}

/* ── Fields and defaults ───────────────────────────────────────────────── */

/** A writable custom field as a form field (custom fields always go last, under "More fields"). */
function customFormField(custom: CustomFieldDef): WriteFormField | null {
  const kind = CUSTOM_FIELD_KINDS[custom.type];
  if (!custom.writable || !kind) return null;
  const choice = kind === 'enum' || kind === 'multiselect';
  return {
    key: custom.key, label: custom.label, kind, ops: ['create', 'update'], required: custom.required, group: CUSTOM_GROUP,
    ...(choice ? { options: { from: 'static', values: custom.options } } : {}),
    // A rating is what the screen's stars store: a whole number from 1 to 5 (CustomFieldRenderer).
    ...(custom.type === 'rating' ? { integer: true, min: 1, max: 5 } : {}),
    // The planner may fill scalars; a list of choices is picked on the form.
    plannerFillable: kind !== 'multiselect',
  };
}

/** The form's fields: the WriteCap's for this op (owner pickers only for a
 * caller who may list users, L25), then the writable custom fields, required
 * ones first; at most 40. */
export function fieldsFor(wf: WorkflowModule, op: 'create' | 'update', ctx: FormContext): WriteFormField[] {
  const builtIn = wf.cap.fields.filter((f) => f.ops.includes(op) && (f.kind !== 'owner_user' || ctx.canPickUsers));
  const custom = wf.cap.customFields
    ? ctx.customFields.map(customFormField).filter((f): f is WriteFormField => f !== null)
    : [];
  return [...builtIn, ...custom.filter((f) => f.required), ...custom.filter((f) => !f.required)].slice(0, MAX_FORM_FIELDS);
}

/** Whether a default may go into a select: one of its known options (a list not read yet takes it). */
function isOption(field: WriteFormField, ctx: FormContext, value: unknown): boolean {
  if (field.kind !== 'enum' && field.kind !== 'multiselect') return true;
  const options = ctx.enumOptions[field.key];
  return !options?.length || (typeof value === 'string' && options.includes(value));
}

/** A create form's defaults (origin default, with where each came from). */
export function createDefaults(wf: WorkflowModule, fields: readonly WriteFormField[], ctx: FormContext):
  { form: Record<string, FormValue>; origins: Record<string, FormOrigin>; provenance: Record<string, PrefillSource>; refs: Record<string, StoredRefValue> } {
  const form: Record<string, FormValue> = {};
  const origins: Record<string, FormOrigin> = {};
  const provenance: Record<string, PrefillSource> = {};
  const refs: Record<string, StoredRefValue> = {};
  const set = (key: string, value: FormValue, source: PrefillSource) => {
    form[key] = value;
    origins[key] = 'default';
    provenance[key] = source;
  };
  for (const field of fields) {
    const d = field.default;
    if (!d) continue;
    switch (d.kind) {
      case 'value':
        if (isOption(field, ctx, d.value)) set(field.key, d.value, 'model_default');
        break;
      case 'stage': {
        const key = ctx.stageDefaults[field.key];
        if (key) set(field.key, key, 'stage_default');
        break;
      }
      case 'fs_discount':
        if (ctx.fsDefaults) set(field.key, ctx.fsDefaults.discount, 'fs_defaults');
        break;
      case 'fs_gst':
        if (ctx.fsDefaults) set(field.key, ctx.fsDefaults.gst, 'fs_defaults');
        break;
      case 'branch_currency':
        if (ctx.branchCurrency && isOption(field, ctx, ctx.branchCurrency)) set(field.key, ctx.branchCurrency, 'branch_currency');
        break;
      case 'own_staff_if_scoped': {
        // L20: a caller who only sees part of the records gets their own staff record.
        const own = ctx.ownStaff;
        if (!own || ctx.scope.kind === 'all' || !isObjectIdText(own.id)) break;
        const value: FormRefValue = { ref: own.id, label: own.label };
        if (field.kind === 'ref_many') {
          set(field.key, [value], 'own_staff');
          refs[field.key] = [own];
        } else {
          set(field.key, value, 'own_staff');
          refs[field.key] = own;
        }
        break;
      }
      default:
        break;
    }
  }
  return { form, origins, provenance, refs };
}

/* ── Address prefill (D29, L29) ────────────────────────────────────────── */

/** A revealed address the form may hold: text that is neither masked nor still encrypted. */
function usableAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || looksMasked(text) || isMaskedPiiValue(ADDRESS_KEY, text) || isEncrypted(text)) return null;
  return text;
}

/** The record by its _id under its module's own gates and scope, revealed
 * for the caller (applyPIIProtection: masked unless their role may view it). */
async function revealedRecord(gate: RelatedGate, module: string, ref: StoredRef): Promise<Record<string, unknown> | null> {
  if (!isObjectIdText(ref.id)) return null;
  const side = await gate(module);
  if (!side.ok) return null;
  const row = await scopedFindById(side.cap, side.ctx, ref.id);
  if (!row) return null;
  const [shown] = await applyPIIProtection([row], side.cap.gate.scopeKey, side.ctx.tenantId, side.ctx.branchId, side.ctx.identity.role);
  return shown && typeof shown === 'object' ? shown as Record<string, unknown> : null;
}

/** The work order's address from its site or customer (L29): the site's
 * address for a site-PII viewer when a site is picked; else the customer's
 * address, city, state, postcode and country (non-empty parts joined with
 * ", ") for a customer-PII viewer; else nothing, with the hint ADDRESS_HIDDEN
 * when a customer is picked (an invoice's: INVOICE_ADDRESS_HIDDEN, its billing
 * address). A hidden address is never read for a caller who may not view it,
 * and a masked value is never returned (D29). A failed read gives nothing:
 * the address can still be typed. */
export async function addressPrefill(ctx: FormContext, refs: { customer?: StoredRef; site?: StoredRef }, gate: RelatedGate):
  Promise<{ value?: string; source?: 'customer_address' | 'site_address'; hint?: string }> {
  const hidden = addressHiddenHint(ctx.module);
  try {
    if (refs.site && ctx.sitePiiVisible) {
      const site = await revealedRecord(gate, 'site', refs.site);
      const value = usableAddress(site?.address);
      if (value) return { value, source: 'site_address' };
    }
    if (refs.customer && ctx.customerPiiVisible) {
      const customer = await revealedRecord(gate, 'customer', refs.customer);
      if (!customer) return {};
      const parts = CUSTOMER_ADDRESS_PARTS.map((key) => customer[key])
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
      if (!parts.length) return {};
      const value = usableAddress(parts.join(', '));
      return value ? { value, source: 'customer_address' } : { hint: hidden };
    }
  } catch (err) {
    logger.warn('CRM assist: address prefill read failed', { module: ctx.module, error: (err as Error)?.name ?? 'Error' });
    return {};
  }
  return refs.customer ? { hint: hidden } : {};
}

/** Puts an addressPrefill result into a form's state (L29). The address takes
 * it only while it is free: empty and never typed, or still holding an
 * earlier prefill (provenance customer_address or site_address, origin
 * default); a typed or stored address is never overwritten. A result with no
 * value clears an earlier prefill, so another customer's address isn't left
 * behind. The hint always follows the latest result. Returns whether the
 * address value changed hands (filled or cleared). */
export function applyAddressPrefill(
  state: {
    form: Record<string, FormValue>; origins: Record<string, FormOrigin>;
    provenance: Record<string, PrefillSource>; hints: Record<string, string>;
  },
  prefill: { value?: string; source?: 'customer_address' | 'site_address'; hint?: string },
): boolean {
  const { form, origins, provenance, hints } = state;
  if (prefill.hint) hints[ADDRESS_KEY] = prefill.hint;
  else delete hints[ADDRESS_KEY];
  const origin = origins[ADDRESS_KEY];
  const earlier = origin === 'default' && (provenance[ADDRESS_KEY] === 'customer_address' || provenance[ADDRESS_KEY] === 'site_address');
  if (!earlier && !(origin === undefined && isEmptyValue(form[ADDRESS_KEY]))) return false;
  if (prefill.value && prefill.source) {
    form[ADDRESS_KEY] = prefill.value;
    origins[ADDRESS_KEY] = 'default';
    provenance[ADDRESS_KEY] = prefill.source;
    return true;
  }
  if (!earlier) return false;
  delete form[ADDRESS_KEY];
  delete origins[ADDRESS_KEY];
  delete provenance[ADDRESS_KEY];
  return true;
}

/* ── Update forms (L10) ────────────────────────────────────────────────── */

function toDate(value: unknown): Date | null {
  const d = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  // Decimal128 and similar print as their number.
  if (value && typeof value === 'object' && (value as { _bsontype?: unknown })._bsontype) {
    const n = Number(String(value));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A custom date-time as the screens store it: a day, then (T or a space)
 * the wall time, seconds allowed, and no zone; or the day alone. */
const ZONELESS_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
/** Text that names its zone after the time (Z or an offset). */
const ZONED_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** A custom date-time's stored text, read as the screens write and show it.
 * They store the tenant's wall time with no zone ("2026-11-03T15:00",
 * CustomFieldRenderer's datetime-local input): its day and "HH:mm" (time null
 * for a bare day), taken as written. Text that names its zone is the instant
 * it names. Anything else is null, zone-less text that isn't a real day and
 * time included: zone-less text is never read with new Date(), which would
 * take it in the server's zone. */
export function customDateTimeOf(text: string): { wall: { date: string; time: string | null } } | { at: Date } | null {
  const value = text.trim();
  const m = ZONELESS_DATETIME_RE.exec(value);
  if (m) {
    const timeOk = m[2] === undefined || (Number(m[2]) <= 23 && Number(m[3]) <= 59 && Number(m[4] ?? 0) <= 59);
    return parseIsoCalendarDate(m[1]) && timeOk ? { wall: { date: m[1], time: m[2] === undefined ? null : `${m[2]}:${m[3]}` } } : null;
  }
  const zoned = ZONED_DATETIME_RE.exec(value);
  const at = zoned && parseIsoCalendarDate(zoned[1]) ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? { at } : null;
}

/** A stored date as the form holds it: a date field's calendar day; a
 * date-time's tenant wall time "YYYY-MM-DDTHH:mm", or only its day when it
 * is stored at server-local midnight (an all-day value, instantOrMidnight).
 * A custom date-time's text is read as the screens write it (customDateTimeOf). */
function storedDateToForm(kind: 'date' | 'datetime', value: unknown, timezone: string, custom: boolean): FormValue {
  if (kind === 'date' && typeof value === 'string' && parseIsoCalendarDate(value)) return value;
  let d: Date | null;
  if (kind === 'datetime' && custom && typeof value === 'string') {
    const read = customDateTimeOf(value);
    if (read && 'wall' in read) return read.wall.time === null ? read.wall.date : `${read.wall.date}T${read.wall.time}`;
    d = read ? read.at : null;
  } else {
    d = toDate(value);
  }
  if (!d) return null;
  if (kind === 'date') return dayKeyFor(d, 'date', timezone).key;
  if (isServerMidnight(d)) return serverLocalDateKey(d);
  const wall = utcToWallTime(d, timezone);
  return `${wall.date}T${wall.time}`;
}

/** A stored scalar as the form holds it, by the field's kind; null when empty or of another shape. */
function storedScalarToForm(field: WriteFormField, value: unknown, timezone: string): FormValue {
  switch (field.kind) {
    case 'number': case 'money': case 'percent':
      return toNumber(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'date': case 'datetime':
      return storedDateToForm(field.kind, value, timezone, field.key.startsWith(CUSTOM_PREFIX));
    case 'multiselect':
      if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v !== '');
      return typeof value === 'string' && value ? [value] : null;
    default:
      if (typeof value === 'string') return value;
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  }
}

function refList(value: StoredRefValue | undefined): StoredRef[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** An update form's values from the record as the caller may see it (L10),
 * every field with origin source. References come from `refs` (the stored
 * keys read under scope). A field whose stored value the caller can't see is
 * masked and starts empty, so leaving it empty keeps it: registered PII the
 * role may not view (value ''), and a reference to a record they can't see
 * (value null; a list with any such record is masked whole, so a hidden
 * entry is never dropped by an edit). */
export function recordToForm(wf: WorkflowModule, fields: readonly WriteFormField[], ctx: FormContext, shown: Record<string, unknown>,
  refs: Record<string, StoredRefValue>): { form: Record<string, FormValue>; origins: Record<string, FormOrigin>; masked: string[] } {
  const form: Record<string, FormValue> = {};
  const origins: Record<string, FormOrigin> = {};
  const masked: string[] = [];
  for (const field of fields) {
    origins[field.key] = 'source';
    if (field.pii && !ctx.piiVisible) {
      form[field.key] = '';
      masked.push(field.key);
      continue;
    }
    switch (field.kind) {
      case 'ref': case 'owner_user': case 'related': case 'ref_many': {
        const stored = refList(refs[field.key]);
        if (stored.some((r) => !isObjectIdText(r.id))) {
          form[field.key] = null;
          masked.push(field.key);
          break;
        }
        const values = stored.map((r): FormRefValue => ({
          ref: r.id, label: r.label, ...(field.kind === 'related' ? { module: r.module } : {}),
        }));
        form[field.key] = field.kind === 'ref_many' ? values : values[0] ?? null;
        break;
      }
      default:
        form[field.key] = storedScalarToForm(field, shownValueOf(shown, field.key), ctx.timezone);
    }
  }
  return { form, origins, masked };
}

/* ── The open form for typed answers ───────────────────────────────────── */

/** The open form's fields without values (the write grammar's fill reader and
 * the planner catalog). Options are the enum values known without a read
 * (static, or the model's own enum); a stage's labels come from the
 * grammar's stage words. */
export function formSpecOf(fields: readonly WriteFormField[], form: Record<string, FormValue>, op: 'create' | 'update', module: string): FillFormSpec {
  return {
    module, op,
    fields: fields.map((field): FillField => {
      const custom = field.key.startsWith(CUSTOM_PREFIX);
      const options = field.kind === 'enum' || field.kind === 'multiselect'
        ? enumValuesOf(module, field).map((value) => ({ value, label: custom ? value : humanize(value) }))
        : [];
      const refModules = field.kind === 'ref' || field.kind === 'ref_many' ? (field.ref ? [field.ref.module] : [])
        : field.kind === 'related' ? [...(field.related?.modules ?? [])]
          : field.kind === 'owner_user' ? ['user'] : [];
      return {
        key: field.key, label: field.label, kind: field.kind,
        ...(options.length ? { options } : {}),
        ...(refModules.length ? { refModules } : {}),
        required: field.required,
        filled: !isEmptyValue(form[field.key]),
        ...(field.future ? { future: true } : {}),
      };
    }),
  };
}

/* ── Values read from words ────────────────────────────────────────────── */

function isDateTimeExpr(value: WriteValue): value is DateTimeExpr {
  return !!value && typeof value === 'object' && 'date' in value && 'time' in value;
}

function isDateExpr(value: WriteValue): value is DateExpr {
  return !!value && typeof value === 'object' && !isDateTimeExpr(value) && ('date' in value || 'rel' in value);
}

/** A day and an optional "HH:mm" as a date or date-time field holds them, with
 * the note when it can't be used as written (L14): a date-time with no time
 * (add_time), at midnight (midnight), a date given a time (time_dropped). */
function dayToForm(kind: 'date' | 'datetime', day: string, time: string | null): { value?: FormValue; note?: FieldNote } {
  if (kind === 'date') return time === null ? { value: day } : { value: day, note: 'time_dropped' };
  if (time === null) return { value: day, note: 'add_time' };
  return time === '00:00' ? { value: `${day}T${time}`, note: 'midnight' } : { value: `${day}T${time}` };
}

function dateValueToForm(kind: 'date' | 'datetime', value: WriteValue, ctx: FormContext): { value?: FormValue; note?: FieldNote } {
  if (isDateTimeExpr(value)) return parseIsoCalendarDate(value.date) ? dayToForm(kind, value.date, value.time) : { note: 'which_day' };
  if (isDateExpr(value)) {
    try {
      return dayToForm(kind, dateExprToKey(value, ctx.timezone, ctx.now), null);
    } catch {
      return { note: 'which_day' };
    }
  }
  const m = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(value.trim()) : null;
  if (m && parseIsoCalendarDate(m[1]) && (!m[2] || /^([01]\d|2[0-3]):[0-5]\d$/.test(m[2]))) return dayToForm(kind, m[1], m[2] ?? null);
  return { note: 'which_day' };
}

/** The option a word names: its key, or (case aside) its key or label; else the word itself, for the form to flag. */
function optionKeyOf(field: WriteFormField, ctx: FormContext, word: string): string {
  const text = word.trim();
  const lower = text.toLowerCase();
  if (field.kind === 'stage') {
    const options = ctx.stageOptions[field.key] ?? [];
    return options.find((o) => o.key === text)?.key
      ?? options.find((o) => o.key.toLowerCase() === lower || o.label.toLowerCase() === lower)?.key ?? text;
  }
  const values = ctx.enumOptions[field.key] ?? [];
  return values.find((v) => v === text) ?? values.find((v) => v.toLowerCase() === lower || humanize(v).toLowerCase() === lower) ?? text;
}

/** A value read from the message (the grammar or the planner) as the form
 * holds it. Dates and times follow L14 (never midnight by default); options
 * are matched to their keys; a value of another shape is left out.
 * References never come as values (they are refs). */
export function writeValueToForm(field: WriteFormField, value: WriteValue, ctx: FormContext): { value?: FormValue; note?: FieldNote } {
  switch (field.kind) {
    case 'date': case 'datetime':
      return dateValueToForm(field.kind, value, ctx);
    case 'text': case 'longtext': case 'email': case 'phone':
      if (typeof value === 'string') return { value };
      return typeof value === 'number' && Number.isFinite(value) ? { value: String(value) } : {};
    case 'number': case 'money': case 'percent': {
      const n = typeof value === 'number' || typeof value === 'string' ? toNumber(value) : null;
      return n === null ? {} : { value: n };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : {};
    case 'enum': case 'stage':
      return typeof value === 'string' && value.trim() ? { value: optionKeyOf(field, ctx, value) } : {};
    case 'multiselect': {
      if (typeof value !== 'string') return {};
      const picked = value.split(',').map((v) => v.trim()).filter(Boolean).map((v) => optionKeyOf(field, ctx, v));
      return picked.length ? { value: [...new Set(picked)] } : {};
    }
    default:
      return {};
  }
}
