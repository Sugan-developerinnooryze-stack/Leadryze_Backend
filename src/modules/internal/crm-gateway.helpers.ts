/** Small, testable building blocks for the internal CRM assistant gateway
 * (internal.routes.ts's /crm-* routes): module on/off flags, the effective
 * DataScope per module, the list limit, and validation of the assistant's
 * status / date-range filters. Nothing here is used by a human-facing
 * route. */

import mongoose, { Model } from 'mongoose';
import { AuthRequest, DataScope } from '../../types';
import { CrmWriteModuleDef } from './crm-write.module-map';
import { Lead } from '../native-crm/leads/lead.model';
import { NativeWorkorder } from '../native-crm/workorders/workorder.model';
import { NativeInvoice } from '../native-crm/invoices/invoice.model';
import { NativeCategory } from '../native-crm/categories/category.model';
import { NativeService } from '../native-crm/services/service.model';
import { NativePart } from '../native-crm/parts/part.model';
import { NativeProduct } from '../native-crm/products/product.model';
import { NativeAsset } from '../native-crm/assets/asset.model';
import { NativeVehicle } from '../native-crm/vehicles/vehicle.model';
import { NativeExpense } from '../native-crm/expenses/expense.model';
import { Company } from '../native-crm/companies/company.model';
import { Task } from '../native-crm/tasks/task.model';
import { Ticket } from '../native-crm/tickets/ticket.model';
import { Call } from '../native-crm/calls/call.model';
import { NativeSite } from '../native-crm/sites/site.model';
import { NativeTeam } from '../native-crm/teams/team.model';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { Deal } from '../native-crm/deals/deal.model';
import { Contact } from '../native-crm/contacts/contact.model';
import { NativeActivity } from '../native-crm/activities/activity.model';
import { NativeQuotation } from '../native-crm/quotations/quotation.model';
import { DEFAULT_DATA_SCOPE_CONFIG, resolveEffectiveScope } from '../native-crm/shared/data-scope';
import { peekStages } from '../native-crm/pipeline-config/pipeline-config.service';
import {
  TENANT_WINDOW_RANGES, TenantWindowRange, parseIsoCalendarDate, resolveTenantDateWindow,
} from '../native-crm/shared/date-range';
import { runAsAssistantWrite, isAssistantPausedModule } from '../native-crm/shared/assistant-provenance';
import { User } from '../auth/auth.model';
import { logger } from '../../utils/logger';
import { AuditActor, ASSISTANT_USER_AGENT } from '../native-crm/shared/record-write-hooks/types';

/* ── Module on/off flags ─────────────────────────────────────────────── */

/** Flag keys for the gateway routes that are not tied to one registry
 * module — the same keys their human routers use (custom-module.routes.ts,
 * native-crm.router.ts's /custom-fields mount). */
export const CUSTOM_MODULES_FLAG = { flagKey: 'config_customModules', label: 'Custom Modules' } as const;
export const CUSTOM_FIELDS_FLAG = { flagKey: 'config_customFields', label: 'Custom Fields' } as const;

/** Mirrors requireModuleEnabled (module-access.middleware.ts) exactly:
 * SUPER_ADMIN always bypasses, and a module is off only when its effective
 * flag is explicitly `false` — an unset flag (or no tenant/flags at all)
 * counts as on. */
export function isModuleFlagDisabled(
  flags: Record<string, unknown> | null | undefined, flagKey: string, role?: string,
): boolean {
  if (role === 'SUPER_ADMIN') return false;
  return flags?.[flagKey] === false;
}

export function moduleDisabledMessage(label: string): string {
  return `${label} is turned off for this account.`;
}

/* ── DataScope parity ───────────────────────────────────────────────── */

/** The same per-module effective scope every human-facing controller uses
 * (resolveEffectiveScope(req, '<logModule>')): when the tenant has turned
 * row-level scoping OFF for this module, Manager/Agent see everything for
 * it, exactly as on their screens. Calls the real resolveEffectiveScope
 * with the same inputs resolveDataScopeMiddleware would have attached. */
export function effectiveScopeFor(
  baseScope: DataScope, tenantDataScopeConfig: Record<string, boolean> | null | undefined, moduleKey: string,
): DataScope {
  const pseudoReq = {
    dataScope: baseScope,
    dataScopeConfig: { ...DEFAULT_DATA_SCOPE_CONFIG, ...(tenantDataScopeConfig ?? {}) },
  } as unknown as AuthRequest;
  return resolveEffectiveScope(pseudoReq, moduleKey);
}

/* ── List limit ─────────────────────────────────────────────────────── */

export const DEFAULT_LIST_LIMIT = 10;
export const MAX_LIST_LIMIT = 25;

/** NaN, empty, zero or negative -> 10; anything above 25 -> 25. */
export function parseListLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

/* ── Version token for updates (LR-NEG-001) ─────────────────────────── */

/** The optimistic-concurrency token of a record AS IT IS NOW — read from
 * the record POST /crm-write re-fetches immediately before an update, for
 * modules whose update() refuses to run without one (requiresVersionToken).
 * Never taken from the request: the assistant can't send __v/updatedAt. A
 * field the record doesn't carry is left out. */
export function currentVersionToken(record: unknown): { updatedAt?: string; __v?: number } {
  if (!record || typeof record !== 'object') return {};
  const doc: Record<string, unknown> = typeof (record as { toObject?: unknown }).toObject === 'function'
    ? (record as { toObject: () => Record<string, unknown> }).toObject()
    : record as Record<string, unknown>;
  const token: { updatedAt?: string; __v?: number } = {};
  if (typeof doc.__v === 'number' && Number.isFinite(doc.__v)) token.__v = doc.__v;
  const raw = doc.updatedAt;
  const updatedAt = raw instanceof Date ? raw : (typeof raw === 'string' || typeof raw === 'number') ? new Date(raw) : null;
  if (updatedAt && !Number.isNaN(updatedAt.getTime())) token.updatedAt = updatedAt.toISOString();
  return token;
}

/* ── Branch on create (Phase 1) ─────────────────────────────────────── */

/** The Mongoose model each create-capable registry module writes to. Used
 * only to ask the model's own schema whether it has a `branchId` path —
 * never to query. A module missing here gets no branchId (fails closed).
 * Quotations are created only through the guided form (Increment 7), with
 * the caller's branch as the screen's controller sets it. */
export const CRM_CREATE_MODELS: Readonly<Record<string, Model<any>>> = {
  lead: Lead, workorder: NativeWorkorder, invoice: NativeInvoice, category: NativeCategory,
  service: NativeService, part: NativePart, product: NativeProduct, asset: NativeAsset,
  vehicle: NativeVehicle, expense: NativeExpense, company: Company, task: Task, ticket: Ticket,
  call: Call, site: NativeSite, team: NativeTeam, customer: NativeCustomer, staff: NativeStaff,
  deal: Deal, contact: Contact, activity: NativeActivity, quotation: NativeQuotation,
};

/** True when the module's model really has a `branchId` field (read from
 * its schema, so it can't drift). Company and Call have none — their human
 * screens are tenant-wide and never set one. */
export function moduleHasBranchField(module: string): boolean {
  const model = CRM_CREATE_MODELS[module];
  return !!model && !!model.schema.path('branchId');
}

/** The branch a chat-created record is saved with — the same rule as the
 * human create controllers (`req.body.branchId ?? req.branchId ?? null`
 * minus the body part, which the assistant can never supply): the caller's
 * selected branch from the verified identity, or null for "All Branches".
 * Empty for a module without a branchId field, so nothing is ever passed
 * to it (not left to Mongoose's strict mode to drop). */
export function branchFieldsForCreate(module: string, identityBranchId: string | null | undefined): { branchId?: string | null } {
  return moduleHasBranchField(module) ? { branchId: identityBranchId ?? null } : {};
}

/* ── Assistant provenance (customer reminders/confirmations) ────────── */

/** Registry modules the assistant can create/update whose records feed the
 * customer reminder cron (crm-reminders.scheduler.ts: Call, Task) or the
 * on-create confirmation (confirmation.service.ts: Call, Ticket). Meeting
 * feeds both too, but is read-only for the assistant. */
export const ASSISTANT_STAMPED_MODULES: ReadonlySet<string> = new Set(['call', 'task', 'ticket']);

/** Runs a POST /crm-write create or update. For an ASSISTANT_STAMPED_MODULES
 * module it runs inside runAsAssistantWrite, so the model hooks can pause the
 * record's customer reminders/confirmations in the SAME write. A create always
 * pauses. An update pauses only when it changes a reminder-relevant field
 * compared with `before`, the record as the gateway loaded it. The markers
 * are set server-side and never come from the assistant's `data`, which
 * can't carry them (WRITE_FORBIDDEN_KEYS). The registry closure and the
 * service receive exactly the same arguments as before. Any other module runs
 * exactly as before. */
export function dispatchAssistantWrite<T>(
  module: string, fn: () => Promise<T>, before: Record<string, unknown> | null = null,
): Promise<T> {
  return ASSISTANT_STAMPED_MODULES.has(module) && isAssistantPausedModule(module)
    ? runAsAssistantWrite(module, before, fn)
    : fn();
}

/* ── Audit actor for the assistant's delete audits (Phase 2) ────────── */

/** Stored as AuditLog.actorRole when the verified identity carries no role. */
export const UNKNOWN_AUDIT_ROLE = 'UNKNOWN';
/** Stored as AuditLog.actorEmail when the acting user's email can't be read.
 * Deliberately not an email address, so it can never pass for a real person. */
export const UNRESOLVED_AUDIT_EMAIL = '(unresolved)';

/** The audit actor for a delete the CRM assistant makes, resolved on the
 * server: id = the verified identity's userId, email = that user's email
 * (User lookup by id, email only — the internalAuth token carries no email),
 * role = the identity's role, userAgent 'crm-assistant', no ip (the request
 * comes from the AI service, not the staff member's browser; stored as
 * 'unknown'). AuditLog requires a non-empty email and role, so a missing
 * value never silently drops the audit: the entry is written with
 * UNRESOLVED_AUDIT_EMAIL / UNKNOWN_AUDIT_ROLE and an error is logged with
 * the userId. Never throws. */
export async function resolveAssistantAuditActor(identity: { userId?: string; role?: string }): Promise<AuditActor> {
  const userId = typeof identity.userId === 'string' ? identity.userId : '';
  let email: string | null = null;
  let lookupError: string | undefined;
  try {
    const user = await User.findById(userId).select('email').lean() as { email?: unknown } | null;
    email = typeof user?.email === 'string' && user.email.trim() ? user.email : null;
    if (!user) lookupError = 'user not found';
  } catch (err) {
    lookupError = (err as Error)?.message ?? 'lookup failed';
  }
  const role = typeof identity.role === 'string' && identity.role.trim() ? identity.role : null;
  if (!email) {
    logger.error('CRM assistant audit: actor email could not be resolved; audit entry written with a placeholder email', {
      userId, storedEmail: UNRESOLVED_AUDIT_EMAIL, reason: lookupError ?? 'user has no email',
    });
  }
  if (!role) {
    logger.error('CRM assistant audit: verified identity has no role; audit entry written with a placeholder role', {
      userId, storedRole: UNKNOWN_AUDIT_ROLE,
    });
  }
  return {
    id: userId,
    email: email ?? UNRESOLVED_AUDIT_EMAIL,
    role: role ?? UNKNOWN_AUDIT_ROLE,
    userAgent: ASSISTANT_USER_AGENT,
  };
}

/* ── Record ids accepted by getById ─────────────────────────────────── */

/** Registry modules whose getById ALSO matches a business/client id when
 * the id is not an ObjectId (read from each service: leadId, workOrderId,
 * invoiceId, serviceId, partId, productId, vehicleId, expenseId, ticketId,
 * siteId, customerId, quotationId, contractId, receiptId, and clientId for
 * deals/contacts). Every other module's getById looks up by `_id` only. */
const BUSINESS_ID_MODULES = new Set([
  'lead', 'workorder', 'invoice', 'service', 'part', 'product', 'vehicle', 'expense',
  'ticket', 'site', 'customer', 'deal', 'contact', 'quotation', 'contract', 'receipt',
]);

/** True when no record of this module can have this id: it is neither an
 * ObjectId nor (for a module that accepts one) a business/client id.
 * GET /crm-get and POST /crm-write answer 404 for it instead of letting
 * an `_id`-only lookup throw a CastError. */
export function isUnresolvableRecordId(module: string, id: unknown): boolean {
  if (typeof id !== 'string' || !id.trim()) return true;
  if (mongoose.isValidObjectId(id)) return false;
  return !BUSINESS_ID_MODULES.has(module);
}

/** A 24-hex-character ObjectId string (stricter than isValidObjectId,
 * which also accepts any 12-character string). */
export function isHexObjectId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
}

/** The record's real `_id` as a string, from a Mongoose document or a
 * plain/lean object. Undefined when it has none. */
export function recordObjectId(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const doc = typeof (record as { toObject?: unknown }).toObject === 'function'
    ? (record as { toObject: () => Record<string, unknown> }).toObject()
    : record as Record<string, unknown>;
  return doc._id === undefined || doc._id === null ? undefined : String(doc._id);
}

/* ── Record locks ───────────────────────────────────────────────────── */

/** The modules record-lock.service.ts's getModels() knows — the only ones
 * that can be locked, and the ones whose human PUT/DELETE routes use
 * requireUnlocked(<this key>). Keys are logModule values. */
const RECORD_LOCK_MODULES = new Set([
  'leads', 'customers', 'contacts', 'deals', 'invoices', 'contracts', 'quotations', 'workorders',
]);

export function isRecordLockModule(logModule: string): boolean {
  return RECORD_LOCK_MODULES.has(logModule);
}

/** The exact 423 message requireUnlocked (record-lock.middleware.ts) sends. */
export function recordLockedMessage(lockReason: unknown): string {
  return `This record is locked: "${lockReason}". Contact an administrator to unlock.`;
}

/* ── Stale-write check ──────────────────────────────────────────────── */

const ISO_DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return typeof (value as { toObject?: unknown }).toObject === 'function'
    ? (value as { toObject: () => Record<string, unknown> }).toObject()
    : value as Record<string, unknown>;
}

/** Mongo/BSON scalar types (ObjectId, Decimal128, ...): compared as String(). */
function isBsonValue(value: unknown): boolean {
  return value instanceof mongoose.Types.ObjectId
    || (!!value && typeof value === 'object' && typeof (value as { _bsontype?: unknown })._bsontype === 'string');
}

function isPlainValueObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && !isBsonValue(value) && !Buffer.isBuffer(value);
}

/** One comparable string per value, so the record as stored (Date,
 * ObjectId, number) and the snapshot as it came through JSON (ISO string,
 * hex string) agree: null/undefined -> '', Date and ISO-like date strings
 * -> the instant's ISO string, ObjectId -> hex, arrays/objects -> JSON of
 * their normalized members (object keys sorted). */
export function normalizeSnapshotValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (isBsonValue(value)) return String(value);
  if (typeof value === 'string') {
    if (ISO_DATE_LIKE.test(value.trim())) {
      const instant = new Date(value.trim());
      if (!Number.isNaN(instant.getTime())) return instant.toISOString();
    }
    return value;
  }
  if (Array.isArray(value)) return JSON.stringify(value.map(normalizeSnapshotValue));
  if (typeof value === 'object') {
    const plain = toPlainRecord(value);
    return JSON.stringify(Object.keys(plain).sort().map((k) => [k, normalizeSnapshotValue(plain[k])]));
  }
  return String(value);
}

function snapshotValueMatches(expected: unknown, actual: unknown): boolean {
  // An object in the snapshot is what /crm-get showed of it: a populated
  // reference's projected sub-keys (Site's customerId -> {_id, name}) or
  // only the writable custom fields — so only those keys are compared.
  if (isPlainValueObject(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)
      && !(actual instanceof Date) && !isBsonValue(actual)) {
    const actualPlain = toPlainRecord(actual);
    return Object.entries(expected).every(([k, v]) => snapshotValueMatches(v, actualPlain[k]));
  }
  return normalizeSnapshotValue(expected) === normalizeSnapshotValue(actual);
}

/** The keys of `expected` (the proposal-time /crm-get snapshot) whose value
 * no longer matches `record` — the record re-fetched right before the
 * write, already through the same PII decrypt/mask /crm-get applies, so a
 * PII value is compared as shown (decrypted or masked), never as
 * ciphertext. A dotted key (customFields.x) is read as a path. */
export function staleSnapshotKeys(expected: Record<string, unknown>, record: unknown): string[] {
  const plain = toPlainRecord(record);
  return Object.entries(expected)
    .filter(([key, value]) => {
      const actual = key in plain || !key.includes('.')
        ? plain[key]
        : key.split('.').reduce<unknown>((acc, part) => (isPlainValueObject(acc) ? toPlainRecord(acc)[part] : undefined), plain);
      return !snapshotValueMatches(value, actual);
    })
    .map(([key]) => key);
}

/* ── Status / date-range filters (C1/C2) ────────────────────────────── */

export interface AppliedFilters {
  status?: string;
  range?: string;
  /** ISO instant — start of the window. */
  from?: string;
  /** ISO instant — end of the window. */
  to?: string;
  timezone?: string;
}

export type CrmReadFilterResult =
  | { ok: true; listOpts: Record<string, unknown>; appliedFilters: AppliedFilters }
  | { ok: false; message: string };

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** A query value must be one string; repeated keys (?status=a&status=b)
 * are rejected rather than silently picking one. Empty means "not given". */
function readSingle(query: Record<string, unknown>, key: string): { value?: string; error?: string } {
  const raw = query[key];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { error: `"${key}" must be a single value.` };
  const value = raw.trim();
  return value ? { value } : {};
}

/** The status values a module really has: the tenant's own pipeline stage
 * keys for lead/workorder/invoice/task/ticket (inactive stages included —
 * old records can still carry a retired stage, and filtering on one is
 * harmless), or the model's fixed enum for every other module. `listed` is
 * what an error message shows (active stages only, when there are any).
 * Stages are only read (peekStages: the saved stages, or the defaults when
 * the tenant has none yet), so a status filter never creates a
 * PipelineConfig document. */
export async function getStatusOptions(
  def: CrmWriteModuleDef, tenantId: string,
): Promise<{ accepted: Array<{ value: string; aliases: string[] }>; listed: string[] }> {
  if (def.statusFilter.kind === 'pipeline') {
    const stages = await peekStages(tenantId, def.statusFilter.pipelineModule);
    const accepted = stages.map((s) => ({ value: s.key, aliases: [s.key, s.label].filter(Boolean) as string[] }));
    // peekStages reads lean, so the schema's isActive default is not applied:
    // a stage saved before the field existed counts as active, as it did on
    // a hydrated read.
    const active = stages.filter((s) => s.isActive !== false).map((s) => s.key);
    return { accepted, listed: active.length > 0 ? active : stages.map((s) => s.key) };
  }
  if (def.statusFilter.kind === 'none') return { accepted: [], listed: [] };
  const path: any = def.statusFilter.model.schema.path(def.statusFilter.field);
  const values: string[] = Array.isArray(path?.enumValues) ? path.enumValues : [];
  return { accepted: values.map((v) => ({ value: v, aliases: [v] })), listed: values };
}

/** Resolves a caller-supplied status to the module's real value (matching
 * is case-insensitive and treats spaces/hyphens as underscores, and a
 * pipeline stage may also be named by its label), or explains what is
 * valid. */
export async function resolveStatusFilter(
  def: CrmWriteModuleDef, tenantId: string, raw: string,
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  if (def.statusFilter.kind === 'none') return { ok: false, message: `${def.label} can't be filtered by status.` };
  const { accepted, listed } = await getStatusOptions(def, tenantId);
  const wanted = normalizeToken(raw);
  // A real key always wins over another stage's label.
  const match = accepted.find((o) => normalizeToken(o.value) === wanted)
    ?? accepted.find((o) => o.aliases.some((a) => normalizeToken(a) === wanted));
  if (match) return { ok: true, value: match.value };
  const valid = listed.length > 0 ? listed.join(', ') : '(none configured)';
  return { ok: false, message: `Unknown status "${raw}" for ${def.label}. Valid values: ${valid}` };
}

/** Validates and converts the assistant's status / range / dateFrom /
 * dateTo (and dateField, when a range is given) into list() options.
 * Named ranges and custom dates become an exact UTC window in the TENANT's
 * timezone, passed to list() as range:'exact' (see resolveDateRange). */
export async function parseCrmReadFilters(
  def: CrmWriteModuleDef,
  query: Record<string, unknown>,
  ctx: { tenantId: string; timezone?: string | null; now?: Date },
): Promise<CrmReadFilterResult> {
  const listOpts: Record<string, unknown> = {};
  const appliedFilters: AppliedFilters = {};

  const status = readSingle(query, 'status');
  if (status.error) return { ok: false, message: status.error };
  const range = readSingle(query, 'range');
  if (range.error) return { ok: false, message: range.error };
  const dateFrom = readSingle(query, 'dateFrom');
  if (dateFrom.error) return { ok: false, message: dateFrom.error };
  const dateTo = readSingle(query, 'dateTo');
  if (dateTo.error) return { ok: false, message: dateTo.error };
  const dateField = readSingle(query, 'dateField');
  if (dateField.error) return { ok: false, message: dateField.error };

  if (status.value) {
    const resolved = await resolveStatusFilter(def, ctx.tenantId, status.value);
    if (!resolved.ok) return resolved;
    listOpts.status = resolved.value;
    appliedFilters.status = resolved.value;
  }

  const rangeKey = range.value ? normalizeToken(range.value) : undefined;
  if (!rangeKey) {
    if (dateFrom.value || dateTo.value) {
      return { ok: false, message: 'dateFrom and dateTo can only be used with range=custom.' };
    }
    // No range: dateField stays what it always was — forwarded untouched,
    // and inert without a range.
    if (dateField.value) listOpts.dateField = dateField.value;
    return { ok: true, listOpts, appliedFilters };
  }

  if (!(TENANT_WINDOW_RANGES as readonly string[]).includes(rangeKey)) {
    return { ok: false, message: `Unknown range "${range.value}". Valid values: ${TENANT_WINDOW_RANGES.join(', ')}` };
  }
  if (!def.dateFilter) {
    return { ok: false, message: `${def.label} can't be filtered by date.` };
  }
  const field = dateField.value ?? def.dateFilter.defaultField;
  if (!def.dateFilter.fields.includes(field)) {
    return { ok: false, message: `${def.label} can't be filtered by "${field}". Date fields: ${def.dateFilter.fields.join(', ')}` };
  }

  if (rangeKey === 'custom') {
    if (!dateFrom.value || !dateTo.value) {
      return { ok: false, message: 'A custom range needs both dateFrom and dateTo (YYYY-MM-DD).' };
    }
    const from = parseIsoCalendarDate(dateFrom.value);
    if (!from) return { ok: false, message: `dateFrom "${dateFrom.value}" is not a valid date. Use YYYY-MM-DD.` };
    const to = parseIsoCalendarDate(dateTo.value);
    if (!to) return { ok: false, message: `dateTo "${dateTo.value}" is not a valid date. Use YYYY-MM-DD.` };
    if (Date.UTC(from.year, from.month0, from.day) > Date.UTC(to.year, to.month0, to.day)) {
      return { ok: false, message: 'dateFrom must be on or before dateTo.' };
    }
  } else if (dateFrom.value || dateTo.value) {
    return { ok: false, message: 'dateFrom and dateTo can only be used with range=custom.' };
  }

  const window = resolveTenantDateWindow(rangeKey as TenantWindowRange, ctx.timezone, dateFrom.value, dateTo.value, ctx.now);
  if (!window) return { ok: false, message: `Could not resolve the "${range.value}" date range.` };

  listOpts.range = 'exact';
  listOpts.dateField = field;
  listOpts.dateFrom = window.start.toISOString();
  listOpts.dateTo = window.end.toISOString();
  appliedFilters.range = rangeKey;
  appliedFilters.from = window.start.toISOString();
  appliedFilters.to = window.end.toISOString();
  appliedFilters.timezone = window.timeZone;
  return { ok: true, listOpts, appliedFilters };
}
