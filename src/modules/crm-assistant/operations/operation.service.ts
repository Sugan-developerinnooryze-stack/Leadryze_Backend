import { createHash } from 'crypto';
import { CRM_WRITE_MODULE_MAP, CrmWriteModuleDef, permissionKeyFor } from '../../internal/crm-write.module-map';
import { applyPIIProtection, readFieldKeysFor } from '../../internal/crm-read.service';
import {
  currentVersionToken, isModuleFlagDisabled, isRecordLockModule, moduleDisabledMessage, resolveAssistantAuditActor,
} from '../../internal/crm-gateway.helpers';
import { ASSISTANT_USER_AGENT, AuditActor } from '../../native-crm/shared/record-write-hooks/types';
import { getLockStatus } from '../../native-crm/record-lock/record-lock.service';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { invalidateDailyEventsForTenant } from '../../daily-events/daily-events.service';
import { ADMIN_ROLES, PII_FIELDS } from '../../../platform/pii/constants';
import { maskField } from '../../../platform/pii/masking.service';
import { STALE_WRITE_MESSAGE } from '../../../utils/stale-write';
import type { WriteGuard } from '../../../utils/stale-write';
import { logger } from '../../../utils/logger';
import type { DataScope } from '../../../types';
import type { AssistIdentity } from '../identity';
import { GatewayTenant, identityHasPermission, isAdminIdentity, resolveScopeForIdentity } from '../gates';
import { getModuleCap } from '../registry';
import type { FieldCap, ModuleCap, WriteFormField } from '../registry/types';
import { cellFor, sourceRefFor, titleOf } from '../views/compose';
import { scrubIds } from '../views/fallback-text';
import { ReadContext, loadStatusInfo } from '../query/execute-list';
import { gateRelated } from '../query/relations';
import { isKnownAppLink, listLinkFor, recordLinkFor } from '../contracts/routes';
import {
  Cell, ResultBlock, ResultBlockSchema, ReviewBlock, ReviewBlockSchema, collectLinks,
} from '../contracts/views';
import type {
  ConfirmOperationRequest, OperationOutcome, SessionOnlyRequest, StageOperationRequest, StageOperationResult,
} from '../contracts/api';
import {
  CrmAssistOperation, CrmAssistOperationDoc, OperationOp, TargetVersion, STAGED_TTL_MS, PURGE_AFTER_MS, newOperationId,
} from './operation.model';
import { AppliedAuditEntry, auditOperationStep, findAppliedAuditEntry } from './audit';
import { FieldChange, createChanges, fieldKeysOf, reduceToChanges } from './diff';
import { fieldLabel, validateWriteValues } from './validate';
import { operationWarningsFor, sideEffectsFor } from './side-effects';
import {
  OPEN_OPERATION_STATUSES, UNKNOWN_OUTCOME_MESSAGE, expireIfDue, isStuckExecuting, markUnknown, transitionOperation,
} from './expiry-sweep';
import type { SealedPayload, VersionToken, WorkflowSealed } from './sealed';
import { isWorkflowSealed, seal, unseal } from './sealed';
import { isWorkflowsEffective } from './workflow-gate';
import { fieldsFor, loadFormContext } from './prefill';
import { runFormStack, sameWriteValues } from './form-stack';
import { ExecuteWriteOutcome, executeWrite } from '../writes/execute-write';
import { workflowModuleFor } from '../writes/write-caps';
import { withWriteLock } from '../writes/locks';
import type { StackResult, WorkflowModule } from '../writes/workflow-types';

/* Server-staged operations (plan 5, Increment 2). The existing assistant's
 * proposals (origin 'legacy_propose') are staged here instead of being held
 * by the AI service:
 *
 *   stage   -> checks module, flag and permission, loads the target under
 *              the caller's scope, captures its version, runs the
 *              validation stack, keeps only the changed keys, builds the
 *              review on the server, seals the values and stores the
 *              operation (10-minute expiry). The session's previous open
 *              change (staged, or a guided form's draft) is superseded.
 *   confirm -> claims the operation atomically (one write, ever), re-checks
 *              flag, permission, scope, version and the validation stack,
 *              then writes through execute-write.ts with compare-and-set.
 *              A guided form's change (origin 'workflow', Increment 6,
 *              reviewed by workflow.service.ts) is re-checked as its form:
 *              guided forms still on, and the form's own stack in commit
 *              mode on exactly the reviewed form.
 *   cancel / status, of a staged change or a guided form's draft.
 *
 * Every transition writes its audit entry (ids and keys only). Messages are
 * server-written; a service's own error text never reaches the reply.
 *
 * Increment 7 (spec B5.9): a guided create made from another record runs
 * its re-check and write under the module's lock (an invoice from a work
 * order: one at a time per work order); a service error the module can word
 * for the caller is shown in its words (never the raw text); after an applied
 * create the module may add one sentence to the result ("<WO> will show as
 * Converted."), kept for a repeated confirm or a status. Quotations are never
 * staged or confirmed on the legacy path (M21): only through their form. */

export interface OperationCaller {
  identity: AssistIdentity;
  tenant: GatewayTenant;
  /** Stored as NativeCrmLog.url by a confirm. */
  url: string;
  now?: Date;
}

export type OperationReply =
  | { http: 200; outcome: OperationOutcome }
  | { http: 409; message: string };

/** The sealed payload's version token (sealed.ts), for the callers that capture one. */
export type { VersionToken } from './sealed';

/* ── Messages ────────────────────────────────────────────────────────── */

export const BRANCH_SWITCHED_MESSAGE = 'You switched company; review this change again.';
export const REVIEW_CHANGED_MESSAGE = 'This change was updated after the version you confirmed. Review it again.';
export const NOTHING_CHANGES_MESSAGE = 'Nothing would change: the record already has these values.';
export const PENDING_MESSAGE = 'Waiting for your confirmation.';
export const EXECUTING_MESSAGE = 'This change is still being applied. Check again in a moment.';
export const CANCELLED_MESSAGE = 'Cancelled. Nothing was changed.';
export const EXPIRED_MESSAGE = 'This change expired before it was confirmed. Nothing was changed. Ask again to review it.';
export const SUPERSEDED_MESSAGE = 'A newer change replaced this one. Nothing was changed.';
export const GENERIC_FAILED_MESSAGE = "The change couldn't be saved. Nothing was changed.";
/* The guided forms (Increment 6, spec B20). */
export const FORM_OPEN_MESSAGE = 'This form is still open. Finish it in the chat, or cancel it.';
export const FORM_BRANCH_MESSAGE = 'You switched company. Switch back to finish this form, or cancel it.';
export const FORM_CLOSED_MESSAGE = 'This form is no longer open.';
export const WORKFLOWS_OFF_MESSAGE = 'Guided forms are turned off for your company. Nothing was changed.';
/** After "Created <singular> <number>." when the creator can't see what they created (B12.8, L15, L20). */
export const UNSEEN_AFTER_CREATE_MESSAGE = "It isn't assigned to you, so you can't open it.";

const IMPERATIVE: Record<OperationOp, string> = { create: 'Create', update: 'Update', delete: 'Delete' };
const PAST: Record<OperationOp, string> = { create: 'Created', update: 'Updated', delete: 'Deleted' };
const PERMISSION_VERB: Record<OperationOp, string> = { create: 'create', update: 'edit', delete: 'delete' };
const GUIDED_ONLY_WRITE_MODULES: ReadonlySet<string> = new Set(['quotation']); // M21: never on the legacy staged path

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const lower = (s: string) => s.toLowerCase();

export function toPlain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const maybe = value as { toObject?: () => Record<string, unknown> };
  return typeof maybe.toObject === 'function' ? maybe.toObject() : value as Record<string, unknown>;
}

function isoOf(value: unknown): string | null {
  const d = value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export function textOf(value: unknown, max = 80): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const s = scrubIds(String(value));
  return s ? clip(s, max) : undefined;
}

/* ── Payload hash ────────────────────────────────────────────────────── */

function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    if ((value as { _bsontype?: unknown })._bsontype) return String(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical executable payload: module, op, record id,
 * values and the version the write is conditioned on. */
export function computePayloadHash(input: {
  module: string; op: OperationOp; recordId: string | null; values: Record<string, unknown>; version: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

/** "3F9A-12C0": the short form people compare on the card. */
export function digestOf(hash: string): string {
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase();
}

export function hashVersion(target: CrmAssistOperationDoc['target'], token?: VersionToken): unknown {
  if (!target) return null;
  return 'token' in target.version ? { token: 'service', updatedAt: token?.updatedAt ?? null, __v: token?.__v ?? null } : target.version;
}

function hashOfOperation(doc: Pick<CrmAssistOperationDoc, 'module' | 'op' | 'target'>, sealed: SealedPayload): string {
  return computePayloadHash({
    module: doc.module, op: doc.op, recordId: doc.target?.id ?? null, values: sealed.values,
    version: hashVersion(doc.target, sealed.source.versionToken),
  });
}

/* ── Review cells ────────────────────────────────────────────────────── */

export async function reviewReadContext(
  cap: ModuleCap, def: CrmWriteModuleDef, tenantId: string, branchId: string | null, role: string,
): Promise<ReadContext> {
  const hasPii = !!PII_FIELDS[def.logModule];
  const isAdmin = ADMIN_ROLES.includes(role);
  const needsCurrency = cap.fields.some((f) => f.money?.currency === 'fs_branch');
  // The same settings document applyPIIProtection reads (fs-settings piiConfig).
  const settings: any = (hasPii && !isAdmin) || needsCurrency ? await getSettings(tenantId, branchId).catch(() => null) : null;
  const viewRoles: string[] = settings?.piiConfig?.find((p: any) => p.module === def.logModule)?.viewRoles ?? [];
  return {
    piiVisible: !hasPii || isAdmin || viewRoles.includes(role),
    currency: needsCurrency && typeof settings?.currency === 'string' ? settings.currency : null,
    status: await loadStatusInfo(cap, tenantId).catch(() => null),
    allowedKeys: new Set(readFieldKeysFor(cap.key)),
  };
}

function capFieldFor(cap: ModuleCap, key: string): FieldCap | undefined {
  return cap.fields.find((f) => !f.virtual && (f.path === key || f.key === key));
}

function isPiiKey(cap: ModuleCap, def: CrmWriteModuleDef, key: string): boolean {
  const top = key.split('.')[0];
  const pii = PII_FIELDS[def.logModule];
  return !!capFieldFor(cap, key)?.pii || (!!pii && (pii.level2.includes(top) || pii.level3.includes(top)));
}

function genericCell(value: unknown, timezone: string): Cell {
  if (value === null || value === undefined || value === '') return { t: 'text', v: null };
  if (typeof value === 'boolean') return { t: 'bool', v: value };
  if (typeof value === 'number') return Number.isFinite(value) ? { t: 'number', v: value } : { t: 'text', v: null };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { t: 'text', v: null } : { t: 'datetime', v: value.toISOString(), tz: clip(timezone, 64) };
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => scrubIds(String(v))).filter(Boolean);
    return { t: 'text', v: parts.length ? clip(parts.join(', '), 300) : null };
  }
  if (typeof value === 'string') {
    const s = scrubIds(value);
    return { t: 'text', v: s ? clip(s, 300) : null };
  }
  return { t: 'text', v: null };
}

/** A typed cell for one value. `alreadyShown`: the value comes from the
 * record as this caller may see it (PII already masked); otherwise a PII
 * value the caller may not view is masked here. */
export function valueCell(
  cap: ModuleCap, def: CrmWriteModuleDef, key: string, value: unknown, read: ReadContext, timezone: string, alreadyShown: boolean,
): Cell {
  if (isPiiKey(cap, def, key) && !read.piiVisible) {
    if (value === null || value === undefined || value === '') return { t: 'text', v: null };
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    if (!raw) return { t: 'text', v: null };
    return { t: 'masked', display: clip(alreadyShown ? raw : maskField(key.split('.')[0], raw), 80) };
  }
  const field = capFieldFor(cap, key);
  if (!field) return genericCell(value, timezone);
  const record: Record<string, unknown> = {};
  const parts = field.path.split('.');
  let cursor = record;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) cursor[part] = value;
    else { cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>; }
  });
  return cellFor(cap, field, record, { ...read, piiVisible: true }, { timezone, scopeKind: 'all', canViewModule: () => false });
}

export function shownValue(record: Record<string, unknown>, key: string): unknown {
  if (key.startsWith('customFields.')) {
    const custom = record.customFields;
    const sub = key.slice('customFields.'.length);
    return custom instanceof Map ? custom.get(sub) : custom && typeof custom === 'object' ? (custom as Record<string, unknown>)[sub] : undefined;
  }
  return record[key];
}

export function statusCellFrom(read: ReadContext | null, key: string | undefined): Extract<Cell, { t: 'status' }> | undefined {
  if (!key) return undefined;
  const option = read?.status?.options.get(key);
  return {
    t: 'status', key: clip(key, 80), label: clip(option?.label ?? key, 120),
    ...(option?.color ? { color: clip(option.color, 16) } : {}), tone: option?.tone ?? 'unknown',
  };
}

/* ── Stage ───────────────────────────────────────────────────────────── */

function refuse(code: Extract<StageOperationResult, { ok: false }>['code'], message: string, fieldErrors?: Record<string, string>): StageOperationResult {
  return { ok: false, code, message, ...(fieldErrors && Object.keys(fieldErrors).length ? { fieldErrors } : {}) };
}

/** The module, its registry entry and the operation's function, or why not. */
export function writableModule(module: string, op: OperationOp): { def: CrmWriteModuleDef; cap: ModuleCap } | null {
  const def = Object.prototype.hasOwnProperty.call(CRM_WRITE_MODULE_MAP, module) ? CRM_WRITE_MODULE_MAP[module] : undefined;
  const cap = def ? getModuleCap(module) : undefined;
  if (!def || !cap || !def[op] || (op !== 'create' && !def.getById)) return null;
  // The registry must name the same gates as the module map (fail closed).
  if (def.flagKey !== cap.gate.flagKey || def.permissionPrefix !== cap.gate.permPrefix || def.logModule !== cap.gate.scopeKey) return null;
  return { def, cap };
}

/** Flag, write permission, and (update / delete, whose review shows the
 * record) view permission. */
export async function checkAccess(
  tenantId: string, tenant: GatewayTenant, identity: AssistIdentity, def: CrmWriteModuleDef, cap: ModuleCap, module: string, op: OperationOp,
): Promise<{ ok: true } | { ok: false; code: 'disabled' | 'no_permission'; message: string }> {
  if (isModuleFlagDisabled(tenant.flags, def.flagKey, identity.role)) {
    return { ok: false, code: 'disabled', message: moduleDisabledMessage(def.label) };
  }
  const writeKey = permissionKeyFor(module, op)!;
  const viewKey = permissionKeyFor(module, 'view')!;
  const allowed = await identityHasPermission(tenantId, identity, writeKey)
    && (op === 'create' || await identityHasPermission(tenantId, identity, viewKey));
  if (!allowed) {
    return { ok: false, code: 'no_permission', message: `You don't have permission to ${PERMISSION_VERB[op]} ${lower(cap.labels.plural)}.` };
  }
  return { ok: true };
}

export function notFoundMessage(cap: ModuleCap): string {
  return `This ${lower(cap.labels.singular)} wasn't found, or you can't see it.`;
}

export function lockedMessage(cap: ModuleCap): string {
  return `This ${lower(cap.labels.singular)} is locked. An administrator can unlock it.`;
}

/** The version a write will be conditioned on, captured from the record. */
export function captureVersion(def: CrmWriteModuleDef, record: unknown, op: OperationOp): { version: TargetVersion; token?: VersionToken } | null {
  if (def.requiresVersionToken) {
    const token = currentVersionToken(record);
    // A delete is conditioned on updatedAt (the service's guard).
    if (op === 'delete' ? !token.updatedAt : (!token.updatedAt && token.__v === undefined)) return null;
    return { version: { token: 'service' }, token };
  }
  const updatedAt = isoOf(toPlain(record).updatedAt);
  return updatedAt ? { version: { updatedAt } } : null;
}

function stageSummary(cap: ModuleCap, op: OperationOp, number: string | undefined, labels: string[]): string {
  const singular = lower(cap.labels.singular);
  const ref = number ? `${singular} ${number}` : (op === 'create' ? singular : `this ${singular}`);
  const shown = labels.slice(0, 8).map(lower);
  const more = labels.length > shown.length ? `, and ${labels.length - shown.length} more` : '';
  return clip(op === 'delete' || !shown.length ? `${IMPERATIVE[op]} ${ref}.` : `${IMPERATIVE[op]} ${ref}: ${shown.join(', ')}${more}.`, 500);
}

/** Supersedes the session's earlier open operations, a guided form's draft
 * or a staged change of either origin (one open change per session, L2).
 * Each moves atomically from whichever open state it is in by then. */
export async function supersedeSessionOperations(tenantId: string, userId: string, sessionId: string, now: Date): Promise<void> {
  const open = await CrmAssistOperation.find({ tenantId, userId, sessionId, status: { $in: [...OPEN_OPERATION_STATUSES] } })
    .select('_id').lean() as Array<{ _id: string }>;
  for (const { _id } of open) {
    const superseded = await transitionOperation(_id, OPEN_OPERATION_STATUSES, { status: 'superseded', purgeAt: new Date(now.getTime() + PURGE_AFTER_MS) });
    if (superseded) await auditOperationStep(superseded, 'superseded');
  }
}

export async function stageOperation(body: StageOperationRequest, caller: OperationCaller): Promise<StageOperationResult> {
  const { identity, tenant } = caller;
  const now = caller.now ?? new Date();
  const tenantId = identity.tenantId;
  const { module, op } = body;
  // A module whose chat writes go only through its guided form (C1): refused before anything is checked or read.
  if (GUIDED_ONLY_WRITE_MODULES.has(module)) return refuse('refused', "This change can't be made from the assistant. Make it on the record's page instead.");

  const target = writableModule(module, op);
  if (!target) return refuse('refused', "This change can't be made from the assistant. Make it on the record's page instead.");
  const { def, cap } = target;
  const singular = lower(cap.labels.singular);

  if (op !== 'create' && !body.recordId) return refuse('validation', `Which ${singular}? A record is required.`, { recordId: 'Required' });

  const access = await checkAccess(tenantId, tenant, identity, def, cap, module, op);
  if (!access.ok) return refuse(access.code, access.message);

  const branchId = identity.branchId ?? null;
  const scope: DataScope = await resolveScopeForIdentity(tenantId, identity, def.logModule, tenant.dataScopeConfig);

  // The target, read under the caller's own scope, and its version.
  let record: unknown = null;
  let captured: { version: TargetVersion; token?: VersionToken } | null = null;
  if (op !== 'create') {
    // The lookup the write itself makes (contacts: ids only, never forCaller),
    // so nothing is staged that the write would refuse.
    record = await def.getById!(body.recordId!, tenantId, scope);
    if (!record) return refuse('not_found', notFoundMessage(cap));
    captured = captureVersion(def, record, op);
    if (!captured) return refuse('refused', `This ${singular} can't be changed from the assistant because its version can't be checked. Use the ${lower(cap.labels.plural)} page.`);
    if (!isAdminIdentity(identity) && isRecordLockModule(def.logModule)) {
      const lock = await getLockStatus(tenantId, def.logModule, body.recordId!).catch(() => null);
      if (lock?.isLocked) return refuse('refused', lockedMessage(cap));
    }
  }

  // The validation stack, then only what really changes.
  let values: Record<string, unknown> = {};
  let changes: FieldChange[] = [];
  let labels: Record<string, string> = {};
  const warnings: string[] = [];
  if (op !== 'delete') {
    const checked = await validateWriteValues({ module, op, tenantId, branchId, def, cap, data: body.data ?? {} });
    if (!checked.ok) return refuse('validation', checked.message, checked.fieldErrors);
    labels = checked.labels;
    warnings.push(...checked.warnings);
    if (op === 'update') {
      // Compared with the stored values, decrypted for the comparison only.
      const [plainRecord] = await applyPIIProtection([record], def.logModule, tenantId, branchId, 'SUPER_ADMIN');
      const reduced = reduceToChanges(checked.values, plainRecord);
      values = reduced.values;
      changes = reduced.changes;
      if (!changes.length) return refuse('validation', NOTHING_CHANGES_MESSAGE, {});
    } else {
      values = checked.values;
      changes = createChanges(values);
      if (!changes.length) return refuse('validation', "There's nothing to save yet. Add at least one value.", {});
    }
  }
  warnings.push(...operationWarningsFor(cap, op));

  // The review, built here from the stored record and the staged values.
  const read = await reviewReadContext(cap, def, tenantId, branchId, identity.role);
  const shown = op === 'create' ? {} : toPlain((await applyPIIProtection([record], def.logModule, tenantId, branchId, identity.role))[0]);
  const recordId = op === 'create' ? null : body.recordId!;
  const number = op !== 'create' && cap.ids.business ? textOf(shown[cap.ids.business]) : undefined;
  const targetLabel = op === 'create' ? undefined : titleOf(cap, shown);
  const fieldKeys = op === 'delete' ? [] : fieldKeysOf(values);
  const operationId = newOperationId();
  const expiresAt = new Date(now.getTime() + STAGED_TTL_MS);
  const targetDoc = recordId && captured ? { id: recordId, version: captured.version } : undefined;
  const payloadHash = computePayloadHash({
    module, op, recordId, values, version: hashVersion(targetDoc, captured?.token),
  });

  const label = (key: string) => clip(fieldLabel(key, cap, labels), 120);
  const review: ReviewBlock = {
    id: clip(`review-${operationId}`, 80),
    type: 'review',
    title: clip(`${IMPERATIVE[op]} ${singular}${number ? ` ${number}` : targetLabel ? ` ${targetLabel}` : ''}`, 200),
    source: sourceRefFor(cap, scope.kind),
    operation: { id: operationId, revision: 1, payloadHash, digest: digestOf(payloadHash), expiresAt: expiresAt.toISOString() },
    module: cap.key,
    op,
    ...(recordId ? {
      target: {
        module: cap.key, id: recordId, ...(number ? { number } : {}), label: clip(targetLabel ?? cap.labels.singular, 200),
        source: cap.group, ...(recordLinkFor(cap.key, recordId) ? { href: recordLinkFor(cap.key, recordId)! } : {}),
      },
    } : {}),
    changes: changes.slice(0, 60).map((c) => ({
      key: clip(c.key, 80),
      label: label(c.key),
      before: op === 'create' ? null : valueCell(cap, def, c.key, shownValue(shown, c.key), read, tenant.timezone, true),
      after: valueCell(cap, def, c.key, c.after, read, tenant.timezone, false),
    })),
    warnings: warnings.slice(0, 10).map((w) => clip(w, 300)),
    sideEffects: sideEffectsFor(cap, op).slice(0, 20).map((s) => ({ kind: s.kind, text: clip(s.text, 300) })),
    status: 'pending',
  };
  const checkedReview = ReviewBlockSchema.safeParse(review);
  const badLink = checkedReview.success ? collectLinks(checkedReview.data).find((p) => !isKnownAppLink(p)) : undefined;
  if (!checkedReview.success || badLink) {
    logger.error('CRM assist: review could not be built; nothing staged', {
      tenantId, module, op, issue: checkedReview.success ? `link ${badLink}` : checkedReview.error.issues[0]?.path.join('.'),
    });
    return refuse('refused', `This change can't be reviewed in the assistant. Use the ${lower(cap.labels.plural)} page.`);
  }

  const actor = await resolveAssistantAuditActor(identity);
  const sealed: SealedPayload = {
    values, review: checkedReview.data,
    source: { origin: 'legacy_propose', ...(captured?.token ? { versionToken: captured.token } : {}), ...(targetLabel ? { targetLabel } : {}) },
  };
  const doc: CrmAssistOperationDoc = {
    _id: operationId,
    tenantId, userId: identity.userId, actorEmail: actor.email, role: actor.role,
    roleId: identity.roleId ?? null, branchId, sessionId: body.sessionId,
    module, op, origin: 'legacy_propose', status: 'staged', revision: 1,
    sealed: seal(sealed),
    fieldKeys,
    ...(targetDoc ? { target: targetDoc } : {}),
    payloadHash,
    sideEffects: review.sideEffects,
    warnings: review.warnings,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_MS),
    claimedAt: null,
  };

  await supersedeSessionOperations(tenantId, identity.userId, body.sessionId, now);
  await CrmAssistOperation.create(doc);
  await auditOperationStep(doc, 'staged');

  return {
    ok: true,
    operationId,
    revision: 1,
    payloadHash,
    expiresAt: expiresAt.toISOString(),
    summary: stageSummary(cap, op, number, fieldKeys.map((k) => fieldLabel(k, cap, labels))),
    review: checkedReview.data,
  };
}

/* ── Outcomes ────────────────────────────────────────────────────────── */

export function resultBlock(block: ResultBlock): ResultBlock | undefined {
  const parsed = ResultBlockSchema.safeParse(block);
  if (!parsed.success || collectLinks(parsed.data).some((p) => !isKnownAppLink(p))) {
    logger.warn('CRM assist: result card dropped', { operationId: block.operationId, issue: parsed.success ? 'link' : parsed.error.issues[0]?.path.join('.') });
    return undefined;
  }
  return parsed.data;
}

function appliedMessage(cap: ModuleCap | undefined, op: OperationOp, ref: string, repeat: boolean): string {
  if (repeat) return clip(`Already applied: ${ref}`, 500);
  return clip(`${PAST[op]} ${cap ? lower(cap.labels.singular) : 'record'} ${ref}.`, 500);
}

/** The applied outcome from the record id, number and title. `unseen`: the
 * caller created a record they can't see (a work order or customer not
 * assigned to them, L15 and L20), so nothing links to it and the message
 * says why: on the first confirm and on every later answer (a repeated
 * confirm, a status). `note`: the module's one more sentence after an applied
 * create (Increment 7: "<WO> will show as Converted."), said after it. */
export async function appliedOutcome(input: {
  operationId: string; module: string; op: OperationOp; recordId: string; number?: string; title?: string;
  statusKey?: string; tenantId: string; repeat: boolean; unseen?: boolean; note?: string;
}): Promise<OperationOutcome> {
  const cap = getModuleCap(input.module);
  const title = clip(input.title || input.number || cap?.labels.singular || 'Record', 200);
  const ref = input.number ?? title;
  const href = input.op !== 'delete' && !input.unseen ? recordLinkFor(input.module, input.recordId) : undefined;
  const said = appliedMessage(cap, input.op, ref, input.repeat);
  // "Already applied: <number>" has no full stop of its own.
  const then = (text: string, more: string) => `${/[.!?]$/.test(text) ? text : `${text}.`} ${more}`;
  const seen = input.unseen ? clip(then(said, UNSEEN_AFTER_CREATE_MESSAGE), 500) : said;
  const message = input.note ? clip(then(seen, input.note), 500) : seen;
  const read = cap && input.statusKey ? { status: await loadStatusInfo(cap, input.tenantId).catch(() => null) } as ReadContext : null;
  const status = input.op !== 'delete' ? statusCellFrom(read, input.statusKey) : undefined;
  const list = listLinkFor(input.module);
  const result = cap ? resultBlock({
    id: clip(`result-${input.operationId}`, 80),
    type: 'result',
    operationId: input.operationId,
    status: 'applied',
    module: input.module,
    op: input.op,
    record: {
      entity: { module: input.module, id: input.recordId, ...(input.number ? { number: input.number } : {}), label: title, source: cap.group },
      title,
      ...(status ? { status } : {}),
      ...(href ? { href } : {}),
    },
    message,
    // A module without a detail page links to its list.
    next: href?.exact
      ? [{ kind: 'open', label: clip(`Open ${lower(cap.labels.singular)}`, 80), href }]
      : list ? [{ kind: 'open', label: clip(`Open ${lower(cap.labels.plural)}`, 80), href: list }] : [],
  }) : undefined;
  return {
    operationId: input.operationId,
    status: 'applied',
    ...(input.repeat ? { repeat: true } : {}),
    record: { id: input.recordId, ...(input.number ? { number: input.number } : {}), title, ...(href ? { href } : {}) },
    message,
    ...(result ? { result } : {}),
  };
}

export function plainOutcome(
  doc: Pick<CrmAssistOperationDoc, '_id' | 'module' | 'op'>,
  status: Exclude<OperationOutcome['status'], 'applied' | 'pending'>, message: string, repeat: boolean,
): OperationOutcome {
  const result = resultBlock({
    id: clip(`result-${doc._id}`, 80), type: 'result', operationId: doc._id, status, module: doc.module, op: doc.op,
    message: clip(message, 500), next: [],
  });
  return { operationId: doc._id, status, ...(repeat ? { repeat: true } : {}), message: clip(message, 500), ...(result ? { result } : {}) };
}

export function pendingOutcome(id: string, message: string = PENDING_MESSAGE): OperationOutcome {
  return { operationId: id, status: 'pending', message };
}

/** What a stored operation says now. */
export async function outcomeOf(doc: CrmAssistOperationDoc, repeat: boolean): Promise<OperationOutcome> {
  switch (doc.status) {
    case 'applied': {
      let sealed: SealedPayload | null;
      try { sealed = unseal(doc.sealed); } catch { sealed = null; }
      // A create its creator can't see keeps no link, however often it is asked about (B12.8 step 8). The module's
      // sentence after the create is said again while the operation is kept (24 h after it is applied); after the
      // purge the answer comes from the audit entry: "Already applied: <number>" with no sentence.
      const unseen = !!sealed && isWorkflowSealed(sealed) && sealed.source.resultUnseen === true;
      const note = sealed && isWorkflowSealed(sealed) ? sealed.source.resultNote : undefined;
      return appliedOutcome({
        operationId: doc._id, module: doc.module, op: doc.op, recordId: doc.result?.recordId ?? doc.target?.id ?? '',
        number: doc.result?.number, title: sealed?.source.resultTitle, statusKey: doc.result?.status, tenantId: doc.tenantId, repeat,
        ...(unseen ? { unseen: true } : {}), ...(note ? { note } : {}),
      });
    }
    case 'failed': return plainOutcome(doc, 'failed', doc.error?.message ?? GENERIC_FAILED_MESSAGE, repeat);
    case 'cancelled': return plainOutcome(doc, 'cancelled', CANCELLED_MESSAGE, repeat);
    case 'expired': return plainOutcome(doc, 'expired', EXPIRED_MESSAGE, repeat);
    case 'superseded': return plainOutcome(doc, 'superseded', SUPERSEDED_MESSAGE, repeat);
    case 'unknown': return plainOutcome(doc, 'unknown', doc.error?.message ?? UNKNOWN_OUTCOME_MESSAGE, repeat);
    case 'executing': return plainOutcome(doc, 'unknown', EXECUTING_MESSAGE, false);
    // A guided form not yet reviewed (B2): nothing to confirm, the form is still open.
    case 'draft': return pendingOutcome(doc._id, FORM_OPEN_MESSAGE);
    default: return pendingOutcome(doc._id);
  }
}

/** Still open: a guided form's draft or a staged change (OPEN_OPERATION_STATUSES). */
function isOpen(doc: Pick<CrmAssistOperationDoc, 'status'>): boolean {
  return OPEN_OPERATION_STATUSES.includes(doc.status);
}

function isDue(doc: Pick<CrmAssistOperationDoc, 'expiresAt'>, now: Date): boolean {
  return new Date(doc.expiresAt).getTime() <= now.getTime();
}

/** An open operation past its expiry: expired now, once, with its audit entry
 * (expired anyway when a sweep or another request got there first). */
async function expiredOutcome(doc: CrmAssistOperationDoc, now: Date): Promise<OperationOutcome> {
  const expired = await expireIfDue(doc._id, now);
  return outcomeOf(expired ?? { ...doc, status: 'expired' }, false);
}

/** No operation this caller owns: the applied audit entry if the operation
 * was applied and then purged, else "expired" (never "not yours"). */
export async function outcomeWithoutDocument(tenantId: string, userId: string, operationId: string): Promise<OperationOutcome> {
  const applied: AppliedAuditEntry | null = await findAppliedAuditEntry(tenantId, userId, operationId).catch(() => null);
  if (applied) {
    return appliedOutcome({
      operationId, module: applied.module, op: applied.op, recordId: applied.recordId, number: applied.number, tenantId, repeat: true,
    });
  }
  return { operationId, status: 'expired', message: EXPIRED_MESSAGE };
}

/** The operation when this caller owns it (tenant, user and session). */
export async function findOwned(operationId: string, identity: AssistIdentity, sessionId: string): Promise<CrmAssistOperationDoc | null> {
  const doc = await CrmAssistOperation.findOne({ _id: operationId, tenantId: identity.tenantId }).lean() as CrmAssistOperationDoc | null;
  if (!doc || doc.userId !== identity.userId || doc.sessionId !== sessionId) return null;
  return doc;
}

/* ── Confirm ─────────────────────────────────────────────────────────── */

type FailureCode = 'refused' | 'disabled' | 'no_permission' | 'validation' | 'not_found' | 'stale_write' | 'locked'
  | 'duplicate' | 'precheck' | 'conflict' | 'integrity' | 'error';

class ConfirmRefusal extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}

/** A failed write as the person reads it: server-written text only. */
function failureFromWrite(outcome: Extract<ExecuteWriteOutcome, { ok: false }>, cap: ModuleCap): ConfirmRefusal {
  const singular = lower(cap.labels.singular);
  switch (outcome.kind) {
    case 'not_found': return new ConfirmRefusal('not_found', `This ${singular} no longer exists, or you can no longer see it. Nothing was changed.`);
    case 'locked': return new ConfirmRefusal('locked', `${lockedMessage(cap)} Nothing was changed.`);
    case 'stale': return new ConfirmRefusal('stale_write', STALE_WRITE_MESSAGE);
    case 'blocked': return new ConfirmRefusal('duplicate', outcome.message);
    case 'precheck': return new ConfirmRefusal('precheck', outcome.message);
    case 'identity': return new ConfirmRefusal('refused', "Your sign-in couldn't be verified. Nothing was changed.");
    default: {
      const err = outcome.error as { name?: string; code?: string; message?: string } | undefined;
      if (err?.name === 'StaleWriteError' || err?.code === 'stale_write') {
        return new ConfirmRefusal('stale_write', typeof err.message === 'string' && err.message ? err.message : STALE_WRITE_MESSAGE);
      }
      if (err?.name === 'VersionError') return new ConfirmRefusal('stale_write', STALE_WRITE_MESSAGE);
      if (outcome.status === 404) return new ConfirmRefusal('not_found', `This ${singular} no longer exists, or you can no longer see it. Nothing was changed.`);
      if (outcome.status === 409) {
        return new ConfirmRefusal('conflict', `This ${singular} is linked to other records or conflicts with one, so nothing was changed. Open it on its page to see why.`);
      }
      return new ConfirmRefusal('error', `The ${singular} couldn't be saved. Nothing was changed.`);
    }
  }
}

async function finishFailed(claimed: CrmAssistOperationDoc, refusal: ConfirmRefusal, now: Date): Promise<OperationOutcome> {
  const failed = await transitionOperation(claimed._id, 'executing', {
    status: 'failed', error: { code: refusal.code, message: refusal.message }, purgeAt: new Date(now.getTime() + PURGE_AFTER_MS),
  });
  if (failed) await auditOperationStep(failed, 'failed');
  return plainOutcome(claimed, 'failed', refusal.message, false);
}

/** The sealed payload with the applied record's name, for the result card (either shape), and, for a guided
 * form's create its creator can't see (`unseen`), resultUnseen: later answers about it leave the link out too. A
 * guided create's sentence after it (`note`) is kept as resultNote, so later answers say it too. */
function withResultTitle(sealed: SealedPayload, resultTitle: string, unseen = false, note?: string): SealedPayload {
  return isWorkflowSealed(sealed)
    ? { ...sealed, source: { ...sealed.source, resultTitle, ...(unseen ? { resultUnseen: true as const } : {}), ...(note ? { resultNote: note } : {}) } }
    : { ...sealed, source: { ...sealed.source, resultTitle } };
}

/* ── A guided form's change at Confirm (B12.8) ── */

/** Work orders and customers show a scoped caller only those assigned to
 * them, so one they create can be invisible to them (L15, L20); so do teams
 * and staff (Increment 7, M23). */
const SEEN_WHEN_ASSIGNED: ReadonlySet<string> = new Set(['workorder', 'customer', 'team', 'staff']);

/** Steps 1 and 2: the module still takes guided forms for this op, and
 * guided forms are still on for the caller (a failed settings read counts
 * as off). */
async function workflowStillOn(claimed: CrmAssistOperationDoc, identity: AssistIdentity): Promise<WorkflowModule> {
  const wf = workflowModuleFor(claimed.module);
  if (!wf || !wf.cap.ops.includes(claimed.op)) {
    throw new ConfirmRefusal('refused', "This change can't be made from the assistant any more. Nothing was changed.");
  }
  if (!await isWorkflowsEffective(identity.tenantId, identity.role).catch(() => false)) {
    throw new ConfirmRefusal('disabled', WORKFLOWS_OFF_MESSAGE);
  }
  return wf;
}

/** The first thing the stack refused, as the person reads it: a field's
 * error (or "Required.") with its label, in form order, then a document's
 * line error ("Lines: ..."), else a form error. */
function firstStackError(stack: StackResult, fields: readonly WriteFormField[]): string {
  for (const field of fields) {
    const error = stack.fieldErrors[field.key] ?? (stack.missing.includes(field.key) ? 'Required.' : undefined);
    if (error) return `${field.label}: ${error}`;
  }
  const lineError = Object.values(stack.lineErrors ?? {})[0];
  if (lineError) return `Lines: ${lineError}`;
  return stack.formErrors[0] ?? Object.values(stack.fieldErrors)[0] ?? 'A required value is missing.';
}

/** Steps 5 and 6: the form's validation stack again in commit mode (any
 * error refuses the write), on the form exactly as reviewed (values,
 * origins, picked records, masked keys, a document's lines and the record it
 * is made from) with the caller's context and the records as they are now
 * (catalog prices read again: a new one changes the values, M12). The values
 * it computes must still be the reviewed ones: a create all of them, an
 * update each reviewed change. Gives the keys the write may set. */
async function recheckWorkflowForm(
  wf: WorkflowModule, sealed: WorkflowSealed,
  input: { def: CrmWriteModuleDef; cap: ModuleCap; op: 'create' | 'update'; caller: OperationCaller; scope: DataScope; current: unknown },
): Promise<string[]> {
  const { def, cap, op, caller, scope } = input;
  const { identity, tenant } = caller;
  const now = caller.now ?? new Date();
  const ctx = await loadFormContext(wf, op, { identity, tenant, now }, { scope });
  const fields = fieldsFor(wf, op, ctx);
  const stack = await runFormStack({
    wf, def, cap, op, mode: 'commit', identity, tenant, ctx, related: gateRelated({ identity, tenant, now }), fields,
    form: sealed.form, origins: sealed.origins, masked: sealed.masked, refs: sealed.refs,
    record: op === 'update' ? toPlain(input.current) : null,
    lines: sealed.lines ?? [], ...(sealed.source.from ? { source: sealed.source.from } : {}),
  });
  if (!stack.ready) {
    throw new ConfirmRefusal('validation', clip(`This change is no longer valid: ${firstStackError(stack, fields)} Review it again.`, 500));
  }
  const same = op === 'create'
    ? sameWriteValues(stack.values, sealed.values)
    : Object.keys(sealed.values).every((key) => sameWriteValues({ [key]: stack.values[key] }, { [key]: sealed.values[key] }));
  if (!same) throw new ConfirmRefusal('validation', 'This change is no longer valid. Review it again.');
  return stack.writable;
}

/** Step 8: whether the caller can read the record they just created (the
 * write's own lookup, under their scope). The write is done, so a failed
 * read changes nothing: the link stays, and only ids are logged. */
async function visibleAfterCreate(def: CrmWriteModuleDef, module: string, recordId: string, tenantId: string, scope: DataScope): Promise<boolean> {
  if (!def.getById) return true;
  try {
    return !!await def.getById(recordId, tenantId, scope);
  } catch (err) {
    logger.warn('CRM assist: could not check that a created record is visible to its creator', {
      tenantId, module, recordId, error: (err as Error)?.message,
    });
    return true;
  }
}

/** Everything after the claim: the re-checks, then the one write. A guided
 * form's change takes the steps of B12.8 in the places marked; the existing
 * assistant's proposals take the path they always have (a guided-only
 * module's are refused). `unseen`: the caller created a record they can't
 * see. `note`: the module's one more sentence after a guided create. */
async function applyClaimed(
  claimed: CrmAssistOperationDoc, caller: OperationCaller, markWriteStarted: () => void,
): Promise<{ recordId: string; number?: string; statusKey?: string; title: string; unseen?: boolean; note?: string }> {
  const { identity, tenant } = caller;
  const tenantId = identity.tenantId;
  const target = writableModule(claimed.module, claimed.op);
  if (!target) throw new ConfirmRefusal('refused', "This change can't be made from the assistant any more. Nothing was changed.");
  const { def, cap } = target;
  const op = claimed.op;

  const access = await checkAccess(tenantId, tenant, identity, def, cap, claimed.module, op);
  if (!access.ok) throw new ConfirmRefusal(access.code, `${access.message} Nothing was changed.`);

  let sealed: SealedPayload;
  try { sealed = unseal(claimed.sealed); } catch {
    throw new ConfirmRefusal('integrity', "This change can't be confirmed. Review it again.");
  }
  // A guided form's change: still a guided-form module, guided forms still on.
  const wf = isWorkflowSealed(sealed) ? await workflowStillOn(claimed, identity) : null;
  // A module whose chat writes go only through its guided form: a change staged on the legacy path never runs (C1).
  if (!wf && GUIDED_ONLY_WRITE_MODULES.has(claimed.module)) {
    throw new ConfirmRefusal('refused', "This change can't be made from the assistant any more. Nothing was changed.");
  }
  if (!claimed.payloadHash || hashOfOperation(claimed, sealed) !== claimed.payloadHash) {
    throw new ConfirmRefusal('integrity', "This change can't be confirmed. Review it again.");
  }

  // The validation stack again, on exactly the reviewed values (a guided
  // form runs its own stack below, once the target has been read).
  let writable: string[] = [];
  if (op !== 'delete' && !wf) {
    const checked = await validateWriteValues({
      module: claimed.module, op, tenantId, branchId: claimed.branchId, def, cap, data: sealed.values,
    });
    if (!checked.ok) throw new ConfirmRefusal('validation', `This change is no longer valid: ${checked.message} Review it again.`);
    const same = computePayloadHash({ module: claimed.module, op, recordId: null, values: checked.values, version: null })
      === computePayloadHash({ module: claimed.module, op, recordId: null, values: sealed.values, version: null });
    if (!same) throw new ConfirmRefusal('validation', 'This change is no longer valid. Review it again.');
    writable = checked.writable;
  }

  const scope = await resolveScopeForIdentity(tenantId, identity, def.logModule, tenant.dataScopeConfig);

  // The target still visible to the caller, and still the version reviewed.
  let current: unknown = null;
  let guard: WriteGuard | undefined;
  let versionToken: Record<string, unknown> | undefined;
  if (op !== 'create') {
    const t = claimed.target;
    if (!t) throw new ConfirmRefusal('integrity', "This change can't be confirmed. Review it again.");
    // The write's own lookup again (contacts: ids only, never forCaller).
    current = await def.getById!(t.id, tenantId, scope);
    if (!current) throw new ConfirmRefusal('not_found', `This ${lower(cap.labels.singular)} no longer exists, or you can no longer see it. Nothing was changed.`);
    const nowVersion = currentVersionToken(current);
    if ('updatedAt' in t.version) {
      if (nowVersion.updatedAt !== t.version.updatedAt) throw new ConfirmRefusal('stale_write', STALE_WRITE_MESSAGE);
      guard = { expectedUpdatedAt: t.version.updatedAt };
    } else {
      const token = sealed.source.versionToken ?? {};
      if ((token.updatedAt ?? null) !== (nowVersion.updatedAt ?? null) || (token.__v ?? null) !== (nowVersion.__v ?? null)) {
        throw new ConfirmRefusal('stale_write', STALE_WRITE_MESSAGE);
      }
      if (op === 'update') versionToken = { ...token };
      else if (token.updatedAt) guard = { expectedUpdatedAt: token.updatedAt };
    }
  }

  const auditActor: AuditActor = { id: claimed.userId, email: claimed.actorEmail, role: claimed.role, userAgent: ASSISTANT_USER_AGENT };
  const recheckAndWrite = async (): Promise<ExecuteWriteOutcome> => {
    // A guided form's create or update: its own stack, on the reviewed form.
    if (wf && isWorkflowSealed(sealed) && op !== 'delete') {
      writable = await recheckWorkflowForm(wf, sealed, { def, cap, op, caller, scope, current });
    }
    markWriteStarted();
    return executeWrite({
      tenantId, module: claimed.module, moduleDef: def, operation: op,
      ...(claimed.target ? { recordId: claimed.target.id } : {}),
      ...(op !== 'delete' ? { data: sealed.values } : {}),
      identity: { userId: identity.userId, role: identity.role, roleId: identity.roleId, branchId: identity.branchId },
      tenant, writable, url: caller.url, scope,
      ...(current ? { current } : {}),
      ...(guard ? { guard } : {}),
      ...(versionToken ? { versionToken } : {}),
      actorName: claimed.actorEmail,
      auditActor,
    });
  };
  // A guided create made from another record runs its re-check and write under the module's lock (an invoice from a
  // work order, M18), so two can't pass the re-check together; while it is held, nothing is written.
  const lock = wf && isWorkflowSealed(sealed) && op === 'create' ? wf.commitLock?.(sealed, tenantId) ?? null : null;
  let outcome: ExecuteWriteOutcome;
  if (lock) {
    const held = await withWriteLock(lock.key, claimed._id, recheckAndWrite, caller.now);
    if (!held.ok) throw new ConfirmRefusal('conflict', lock.busy);
    outcome = held.value;
  } else {
    outcome = await recheckAndWrite();
  }
  if (!outcome.ok) {
    // A service's error the module can word for this caller (scoped), else the generic text; never the raw message.
    let answer: string | null = null;
    if (outcome.kind === 'service' && wf?.mapWriteError && isWorkflowSealed(sealed)) {
      try {
        answer = await wf.mapWriteError({ sealed, identity, tenant, now: caller.now ?? new Date(), message: outcome.message });
      } catch {
        logger.warn('CRM assist: write error not mapped', { tenantId, operationId: claimed._id, module: claimed.module });
      }
    }
    throw answer ? new ConfirmRefusal('precheck', answer) : failureFromWrite(outcome, cap);
  }

  const raw = toPlain(outcome.result);
  const stageField = cap.stage?.field;
  if (op === 'delete') {
    return {
      recordId: claimed.target?.id ?? outcome.recordId,
      ...(sealed.review?.target?.number ? { number: sealed.review.target.number } : {}),
      title: sealed.source.targetLabel ?? sealed.review?.target?.label ?? cap.labels.singular,
    };
  }
  const number = cap.ids.business ? textOf(raw[cap.ids.business]) : undefined;
  const statusKey = stageField && typeof raw[stageField] === 'string' ? clip(raw[stageField] as string, 80) : undefined;
  // The name from the record as this caller sees it (PII masked as on the screens).
  const title = titleOf(cap, outcome.responseData);
  // A work order, customer, team or staff member created from a guided form that its creator can't see: no link to it.
  const unseen = !!wf && op === 'create' && SEEN_WHEN_ASSIGNED.has(claimed.module)
    && !await visibleAfterCreate(def, claimed.module, outcome.recordId, tenantId, scope);
  // The module's one more sentence after an applied create ("<WO> will show as Converted."). The write is done, so a
  // failure only loses the sentence, logged with ids only.
  let note: string | undefined;
  if (wf?.afterApply && op === 'create' && isWorkflowSealed(sealed)) {
    try {
      const said = await wf.afterApply({ sealed, recordId: outcome.recordId, ...(number ? { number } : {}), identity, tenant, now: caller.now ?? new Date() });
      if (typeof said === 'string' && said.trim()) note = clip(said.trim(), 500);
    } catch {
      logger.warn('CRM assist: after-apply step failed', { tenantId, operationId: claimed._id, module: claimed.module, recordId: outcome.recordId });
    }
  }
  return {
    recordId: outcome.recordId, ...(number ? { number } : {}), ...(statusKey ? { statusKey } : {}), title, ...(unseen ? { unseen } : {}),
    ...(note ? { note } : {}),
  };
}

export async function confirmOperation(
  operationId: string, body: ConfirmOperationRequest, caller: OperationCaller,
): Promise<OperationReply> {
  const { identity } = caller;
  const now = caller.now ?? new Date();
  const revision = body.revision ?? 1;
  // Without the hash only the first revision can be confirmed.
  if (!body.payloadHash && revision !== 1) return { http: 409, message: REVIEW_CHANGED_MESSAGE };

  const filter: Record<string, unknown> = {
    _id: operationId, tenantId: identity.tenantId, userId: identity.userId, sessionId: body.sessionId,
    branchId: identity.branchId ?? null, status: 'staged', expiresAt: { $gt: now }, revision,
  };
  if (body.payloadHash) filter.payloadHash = body.payloadHash;
  const claimed = await CrmAssistOperation.findOneAndUpdate(
    filter, { $set: { status: 'executing', claimedAt: now } }, { new: true },
  ).lean() as CrmAssistOperationDoc | null;

  if (!claimed) {
    const doc = await findOwned(operationId, identity, body.sessionId);
    if (!doc) return { http: 200, outcome: await outcomeWithoutDocument(identity.tenantId, identity.userId, operationId) };
    if (isOpen(doc) && isDue(doc, now)) return { http: 200, outcome: await expiredOutcome(doc, now) };
    if (doc.status === 'staged') {
      if ((doc.branchId ?? null) !== (identity.branchId ?? null)) return { http: 200, outcome: pendingOutcome(doc._id, BRANCH_SWITCHED_MESSAGE) };
      if (doc.revision !== revision || (body.payloadHash && body.payloadHash !== doc.payloadHash)) {
        return { http: 409, message: REVIEW_CHANGED_MESSAGE };
      }
      return { http: 200, outcome: pendingOutcome(doc._id, 'This change is still waiting for your confirmation. Try again.') };
    }
    if (doc.status === 'executing' && isStuckExecuting(doc, now)) {
      const unknown = await markUnknown(doc._id, now);
      return { http: 200, outcome: await outcomeOf(unknown ?? doc, true) };
    }
    // A draft (never confirmed; after an Edit its form is open again): pending, FORM_OPEN. Else what it is now.
    return { http: 200, outcome: await outcomeOf(doc, doc.status !== 'executing') };
  }

  await auditOperationStep(claimed, 'confirmed');
  let writeStarted = false;
  try {
    const applied = await applyClaimed(claimed, caller, () => { writeStarted = true; });
    let sealed: SealedPayload | null = null;
    try { sealed = unseal(claimed.sealed); } catch { sealed = null; }
    const result = { recordId: applied.recordId, ...(applied.number ? { number: applied.number } : {}), ...(applied.statusKey ? { status: applied.statusKey } : {}) };
    const done = await transitionOperation(claimed._id, 'executing', {
      status: 'applied',
      result,
      ...(sealed ? { sealed: seal(withResultTitle(sealed, applied.title, applied.unseen === true, applied.note)) } : {}),
      purgeAt: new Date(now.getTime() + PURGE_AFTER_MS),
    });
    await auditOperationStep(done ?? { ...claimed, result }, 'applied');
    // The next Daily Events read shows the change.
    invalidateDailyEventsForTenant(identity.tenantId);
    return {
      http: 200,
      outcome: await appliedOutcome({
        operationId: claimed._id, module: claimed.module, op: claimed.op, recordId: applied.recordId,
        number: applied.number, title: applied.title, statusKey: applied.statusKey, tenantId: identity.tenantId, repeat: false,
        ...(applied.unseen ? { unseen: true } : {}), ...(applied.note ? { note: applied.note } : {}),
      }),
    };
  } catch (err) {
    if (err instanceof ConfirmRefusal) return { http: 200, outcome: await finishFailed(claimed, err, now) };
    logger.error('CRM assist: confirm failed', {
      tenantId: identity.tenantId, operationId: claimed._id, module: claimed.module, op: claimed.op, writeStarted,
      error: (err as Error)?.message,
    });
    if (!writeStarted) return { http: 200, outcome: await finishFailed(claimed, new ConfirmRefusal('error', GENERIC_FAILED_MESSAGE), now) };
    // The write may or may not have happened: never retried, reported as unknown.
    const unknown = await markUnknown(claimed._id, now).catch(() => null);
    return { http: 200, outcome: await outcomeOf(unknown ?? { ...claimed, status: 'unknown' }, false) };
  }
}

/* ── Cancel and status ───────────────────────────────────────────────────
 * Both also answer for a guided form's draft (B2): cancel closes it, status
 * says the form is still open (pending, FORM_OPEN). Any branch may ask. */

export async function cancelOperation(operationId: string, body: SessionOnlyRequest, caller: OperationCaller): Promise<OperationReply> {
  const { identity } = caller;
  const now = caller.now ?? new Date();
  const doc = await findOwned(operationId, identity, body.sessionId);
  if (!doc) return { http: 200, outcome: await outcomeWithoutDocument(identity.tenantId, identity.userId, operationId) };
  if (isOpen(doc)) {
    if (isDue(doc, now)) return { http: 200, outcome: await expiredOutcome(doc, now) };
    // From whichever open state it is in by now (an Edit or a Review may have just moved it).
    const cancelled = await transitionOperation(doc._id, OPEN_OPERATION_STATUSES, {
      status: 'cancelled', purgeAt: new Date(now.getTime() + PURGE_AFTER_MS),
    }, { tenantId: identity.tenantId, userId: identity.userId, sessionId: body.sessionId });
    if (cancelled) {
      await auditOperationStep(cancelled, 'cancelled');
      return { http: 200, outcome: await outcomeOf(cancelled, false) };
    }
    // Lost a race (confirmed, expired or superseded meanwhile): what it is now.
    const latest = await findOwned(operationId, identity, body.sessionId);
    return { http: 200, outcome: latest ? await outcomeOf(latest, latest.status !== 'executing' && !isOpen(latest)) : pendingOutcome(operationId) };
  }
  if (doc.status === 'executing') {
    return { http: 200, outcome: plainOutcome(doc, 'unknown', "This change is already being applied and can't be cancelled now. Check again in a moment.", false) };
  }
  return { http: 200, outcome: await outcomeOf(doc, true) };
}

export async function operationStatus(operationId: string, body: SessionOnlyRequest, caller: OperationCaller): Promise<OperationReply> {
  const { identity } = caller;
  const now = caller.now ?? new Date();
  const doc = await findOwned(operationId, identity, body.sessionId);
  if (!doc) return { http: 200, outcome: await outcomeWithoutDocument(identity.tenantId, identity.userId, operationId) };
  if (isOpen(doc)) {
    if (isDue(doc, now)) return { http: 200, outcome: await expiredOutcome(doc, now) };
    // Pending: a staged change waits for Confirm; a draft's form is still open (FORM_OPEN).
    return { http: 200, outcome: await outcomeOf(doc, false) };
  }
  if (doc.status === 'executing') {
    if (isStuckExecuting(doc, now)) {
      const unknown = await markUnknown(doc._id, now);
      return { http: 200, outcome: await outcomeOf(unknown ?? doc, true) };
    }
    return { http: 200, outcome: await outcomeOf(doc, false) };
  }
  return { http: 200, outcome: await outcomeOf(doc, true) };
}
