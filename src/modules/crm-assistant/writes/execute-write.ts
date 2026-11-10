import type { CrmWriteModuleDef } from '../../internal/crm-write.module-map';
import { applyPIIProtection, projectForDetail } from '../../internal/crm-read.service';
import {
  currentVersionToken, isUnresolvableRecordId, isHexObjectId, recordObjectId, isRecordLockModule, recordLockedMessage,
  staleSnapshotKeys, branchFieldsForCreate, dispatchAssistantWrite, ASSISTANT_STAMPED_MODULES, resolveAssistantAuditActor,
} from '../../internal/crm-gateway.helpers';
import { withoutAssistantMarkers } from '../../native-crm/shared/assistant-provenance';
import { getRecordWriteHooks } from '../../native-crm/shared/record-write-hooks';
import {
  RecordWriteHookContext, BeforeCreateResult, AuditActor,
  CREATE_PRECHECK_FAILED_MESSAGE, UPDATE_PRECHECK_FAILED_MESSAGE,
} from '../../native-crm/shared/record-write-hooks/types';
import { getLockStatus } from '../../native-crm/record-lock/record-lock.service';
import { writeNativeCrmLog } from '../../../middlewares/native-crm-log.middleware';
import { GatewayTenant, resolveScopeForIdentity } from '../gates';
import type { WriteGuard } from '../../../utils/stale-write';
import { logger } from '../../../utils/logger';
import { DataScope } from '../../../types';

/* The one record-write dispatch of the CRM assistant, shared by POST
 * /api/internal/crm-write (the legacy propose/execute path) and the staged
 * operations' Confirm (operations/operation.service.ts). Taken out of the
 * /crm-write route unchanged, step for step:
 *
 *   branch on create (from the verified identity only) -> id check ->
 *   DataScope -> record lock (non-admins) -> stale snapshot (legacy) ->
 *   version token (lead, deal, contact, company) -> the module's pre-write
 *   hooks (duplicate checks, Lead team) -> the service call through the
 *   module map, inside the assistant-provenance scope for call/task/ticket
 *   -> NativeCrmLog -> the post-save hooks (timeline, delete audit,
 *   auto-lock) -> the response, PII-masked like GET /crm-get.
 *
 * Validation (identity, flag, permission, allowlist) stays with the caller.
 * Never runs automations (runAutomations*), on-create confirmations or any
 * message: the hooks registry holds none of them. The caller turns the
 * outcome into its own reply; the HTTP statuses are /crm-write's. */

export interface ExecuteWriteIdentity {
  userId: string;
  role?: string;
  roleId?: string;
  branchId?: string | null;
}

export interface ExecuteWriteInput {
  tenantId: string;
  module: string;
  moduleDef: CrmWriteModuleDef;
  operation: 'create' | 'update' | 'delete';
  /** Required for update and delete. */
  recordId?: string;
  data?: Record<string, unknown>;
  identity: ExecuteWriteIdentity;
  /** For the data-visibility config when no scope is given. */
  tenant: Pick<GatewayTenant, 'dataScopeConfig'>;
  /** The writable keys the response projection adds (as GET /crm-get). */
  writable: string[];
  /** Stored as NativeCrmLog.url. */
  url: string;
  /** The caller's effective scope, when already resolved. */
  scope?: DataScope;
  /** The target as the caller already read it under `scope` (raw). */
  current?: any;
  /** Legacy /crm-write: refuse when anything shown at propose time changed. */
  expectedSnapshot?: Record<string, unknown>;
  /** Compare-and-set for update and delete (the version captured at review). */
  guard?: WriteGuard;
  /** The version token for a requiresVersionToken update; without it the
   * token is read from the record now (as /crm-write always did). */
  versionToken?: Record<string, unknown>;
  /** NativeCrmLog.actorName; the userId when absent (as /crm-write). */
  actorName?: string;
  /** The audit actor when already known (skips the User lookup). */
  auditActor?: AuditActor;
}

export type ExecuteWriteFailureKind = 'identity' | 'not_found' | 'locked' | 'stale' | 'precheck' | 'blocked' | 'service';

export type ExecuteWriteOutcome =
  | {
      ok: true;
      /** The service's own return value. */
      result: any;
      recordId: string;
      /** What /crm-write answers: the record as GET /crm-get shows it to this caller, or { _id } for a delete. */
      responseData: Record<string, unknown>;
    }
  | {
      ok: false;
      status: number;
      /** /crm-write's message; may echo a service error. */
      message: string;
      kind: ExecuteWriteFailureKind;
      /** The thrown error, for kind 'service' and 'precheck'. */
      error?: unknown;
    };

export const RECORD_NOT_FOUND_MESSAGE = 'Record not found or not in scope';
export const STALE_SNAPSHOT_MESSAGE = 'This record changed since you last reviewed it — please ask again for a fresh look.';
const IDENTITY_MESSAGE = 'A verified internalAuth identity is required';

/** A record as NativeCrmLog stores it: plain, without the reminder markers. */
function logSnapshot(record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== 'object') return null;
  const maybe = record as { toObject?: () => Record<string, unknown> };
  const plain = typeof maybe.toObject === 'function' ? maybe.toObject() : record as Record<string, unknown>;
  return withoutAssistantMarkers({ ...plain });
}

export async function executeWrite(input: ExecuteWriteInput): Promise<ExecuteWriteOutcome> {
  const { tenantId, module, moduleDef, operation, recordId, data, identity, url } = input;
  const userId = identity.userId;
  const actorName = input.actorName ?? userId;
  const isAdmin = identity.role === 'SUPER_ADMIN' || identity.role === 'TENANT_ADMIN';
  const notFound = (): ExecuteWriteOutcome => ({ ok: false, status: 404, message: RECORD_NOT_FOUND_MESSAGE, kind: 'not_found' });

  // Branch on CREATE (Phase 1) — the same rule as the human create
  // controllers: the caller's selected branch, or null for "All
  // Branches". Taken ONLY from the verified identity (minted from
  // req.branchId, which resolveBranch checked is an active branch of this
  // tenant), never from the request — `branchId` in `data` is rejected by
  // the allowlist. Modules without a branchId field (Company, Call) get
  // nothing. An update never moves a record to another branch.
  const createBranch = operation === 'create' ? branchFieldsForCreate(module, identity.branchId) : {};
  if (createBranch.branchId != null && !isHexObjectId(createBranch.branchId)) {
    return { ok: false, status: 401, message: IDENTITY_MESSAGE, kind: 'identity' };
  }

  // An id no lookup of this module can match: same 404 as a missing record
  // (an `_id`-only service would otherwise throw a CastError on it).
  if ((operation === 'update' || operation === 'delete') && isUnresolvableRecordId(module, recordId)) return notFound();

  const scope = input.scope ?? await resolveScopeForIdentity(tenantId, identity, moduleDef.logModule, input.tenant.dataScopeConfig);

  let current: any = input.current ?? null;

  // Record locks — the same rule the human PUT/DELETE routes enforce with
  // requireUnlocked (record-lock.middleware.ts): SUPER_ADMIN/TENANT_ADMIN
  // bypass, anyone else gets a 423 while the record is locked, and a
  // failed lock lookup lets the request through, as the middleware does.
  // getLockStatus looks up by `_id`, so a business/client id is first
  // resolved to the record's real `_id` (scoped — not found is a 404).
  if ((operation === 'update' || operation === 'delete') && !isAdmin && isRecordLockModule(moduleDef.logModule)) {
    let lockId: string | undefined = isHexObjectId(recordId) ? recordId : undefined;
    if (!lockId && moduleDef.getById) {
      if (!current) current = await moduleDef.getById(recordId!, tenantId, scope);
      if (!current) return notFound();
      lockId = recordObjectId(current);
    }
    if (lockId) {
      const lock = await getLockStatus(tenantId, moduleDef.logModule, lockId).catch(() => null);
      if (lock?.isLocked) return { ok: false, status: 423, message: recordLockedMessage(lock.lockReason), kind: 'locked' };
    }
  }

  // Stale-write guard (legacy /crm-write): the proposal was built from a
  // snapshot fetched at PROPOSE time. Re-fetch right now, immediately
  // before the real mutation, and refuse if anything the proposal was
  // shown has since changed.
  if ((operation === 'update' || operation === 'delete') && input.expectedSnapshot && moduleDef.getById) {
    if (!current) current = await moduleDef.getById(recordId!, tenantId, scope);
    if (!current) return notFound();
    // The snapshot holds what GET /crm-get showed: PII decrypted or masked
    // for this caller (never ciphertext), dates as ISO strings, ObjectIds
    // as hex. Compare against the same view — the SAME PII step with the
    // SAME branch/role arguments /crm-get uses — and normalized values.
    // `current` itself stays raw for the version token below.
    const [snapshotRecord] = await applyPIIProtection(
      [current], moduleDef.logModule, tenantId, identity.branchId, identity.role ?? 'AGENT',
    );
    if (staleSnapshotKeys(input.expectedSnapshot, snapshotRecord).length > 0) {
      return { ok: false, status: 409, message: STALE_SNAPSHOT_MESSAGE, kind: 'stale' };
    }
  }

  // Version token (LR-NEG-001): lead/company/deal/contact updates refuse
  // to run without the record's updatedAt/__v. The staged operations pass
  // the token captured at review (compare-and-set); /crm-write reads it
  // HERE, server-side, from the record as it is right now — never from the
  // request body, where the allowlist rejects __v/updatedAt. Any edit
  // between this read and the service's own read is still refused by the
  // service.
  let versionToken: Record<string, unknown> = {};
  if (operation === 'update' && moduleDef.requiresVersionToken && moduleDef.getById) {
    if (input.versionToken) {
      versionToken = input.versionToken;
    } else {
      if (!current) current = await moduleDef.getById(recordId!, tenantId, scope);
      if (!current) return notFound();
      versionToken = currentVersionToken(current);
    }
  }

  // The module's internal steps, the same ones its screen controller runs
  // (shared/record-write-hooks): duplicate checks, Lead lastActivityAt and
  // team re-resolution, timeline entries, delete audits, invoice-paid /
  // work-order-completed auto-lock. Never automations or messages. Checks
  // that can refuse the write run here, before anything is written.
  const writeHooks = getRecordWriteHooks(module);
  let auditActor: Promise<AuditActor> | undefined;
  const hookCtx: RecordWriteHookContext = {
    tenantId,
    userId,
    origin: 'assistant',
    // Only a delete audit needs it; resolved once per request.
    getAuditActor: () => (auditActor ??= input.auditActor ? Promise.resolve(input.auditActor) : resolveAssistantAuditActor(identity)),
    swallow: (step) => (stepErr) => {
      logger.warn('CRM assistant post-save step failed (the write itself succeeded)', {
        tenantId, module, operation, step, userId, error: (stepErr as Error)?.message,
      });
    },
  };
  const refuseBeforeWrite = async (
    message: string, status: number, kind: ExecuteWriteFailureKind, error?: unknown,
  ): Promise<ExecuteWriteOutcome> => {
    await writeNativeCrmLog({
      tenantId, actorId: userId, actorName, actorRole: identity.role ?? '',
      action: 'error', module: moduleDef.logModule, resourceId: recordId ?? '',
      error: message, statusCode: status, url, origin: 'assistant',
    }).catch(() => {});
    return { ok: false, status, message, kind, ...(error !== undefined ? { error } : {}) };
  };

  // Create: the duplicate check. Lead/Customer refuse a duplicate (409,
  // generic message — never the other record's name or id); Contact goes
  // ahead and gets a generic note back. If the lookup itself fails,
  // nothing is written (503).
  let createExtras: Record<string, unknown> = {};
  let duplicateWarning: string | undefined;
  if (operation === 'create' && writeHooks?.beforeCreate) {
    let pre: BeforeCreateResult;
    try {
      pre = await writeHooks.beforeCreate(hookCtx, { ...(data ?? {}) });
    } catch (preErr) {
      logger.error('CRM assistant: duplicate check failed before a create; nothing was written', {
        tenantId, module, userId, error: (preErr as Error)?.message,
      });
      return refuseBeforeWrite(CREATE_PRECHECK_FAILED_MESSAGE, 503, 'precheck', preErr);
    }
    if (pre.block) return refuseBeforeWrite(pre.block.message, pre.block.status, 'blocked');
    createExtras = pre.extraFields ?? {};
    duplicateWarning = pre.warning;
  }

  // Update: the record as it was before the write (the screens read it
  // first too). Reuses the read the lock / stale / version-token checks
  // already made; otherwise reads it now, and only when this update's steps
  // use it. A failed read never blocks the write (prev is then null, as on
  // a screen whose read found nothing). The payload is built once; a hook
  // may add server-side keys to it (Lead: teamId/teamName on an owner
  // change — keys the assistant itself can never send).
  const updatePayload: Record<string, unknown> = { ...(data ?? {}), ...versionToken };
  let prev: any = null;
  if (operation === 'update' && writeHooks) {
    if (!current && moduleDef.getById && writeHooks.needsPrevOnUpdate(updatePayload)) {
      current = await moduleDef.getById(recordId!, tenantId, scope).catch((readErr: unknown) => {
        logger.warn('CRM assistant: could not read the record before an update; post-save steps run without it', {
          tenantId, module, userId, error: (readErr as Error)?.message,
        });
        return null;
      });
    }
    prev = current ?? null;
    if (writeHooks.beforeUpdate) {
      try {
        await writeHooks.beforeUpdate(hookCtx, prev, updatePayload);
      } catch (preErr) {
        logger.error('CRM assistant: preparing an update failed; nothing was written', {
          tenantId, module, userId, error: (preErr as Error)?.message,
        });
        return refuseBeforeWrite(UPDATE_PRECHECK_FAILED_MESSAGE, 503, 'precheck', preErr);
      }
    }
  }

  let result: any;
  let stampedBefore: any = null;
  try {
    // Create/update of Call/Task/Ticket run as an assistant write
    // (dispatchAssistantWrite). A create, or an update that changes a
    // reminder-relevant field, pauses the record's customer reminders and
    // confirmations server-side, in the same write.
    if (operation === 'create') {
      // tenantId/createdBy/branchId are NEVER taken from `data` — only from
      // the verified identity (the allowlist already rejects all three; the
      // deletes stay as a second layer).
      const safeData = { ...(data ?? {}) };
      delete (safeData as any).tenantId;
      delete (safeData as any).createdBy;
      delete (safeData as any).branchId;
      // createExtras: server-side create fields from the module's hooks
      // (Lead: lastActivityAt), never from the request.
      result = await dispatchAssistantWrite(module, () => moduleDef.create!(tenantId, { ...safeData, ...createExtras, createdBy: userId, ...createBranch }));
    } else if (operation === 'update') {
      // The pause rule compares the record before and after this write.
      // Reuse an earlier read, or read it now. A failed or empty read never
      // blocks the write: the service still decides 404.
      stampedBefore = ASSISTANT_STAMPED_MODULES.has(module) && moduleDef.getById
        ? (current ?? await moduleDef.getById(recordId!, tenantId, scope).catch(() => null))
        : null;
      const update = moduleDef.update!;
      // The guard is passed only when there is one, so the registry
      // function gets exactly /crm-write's arguments otherwise.
      result = await dispatchAssistantWrite(module, () => (input.guard
        ? update(recordId!, tenantId, updatePayload, scope, input.guard)
        : update(recordId!, tenantId, updatePayload, scope)), stampedBefore);
      if (!result) return notFound();
    } else {
      result = input.guard
        ? await moduleDef.delete!(recordId!, tenantId, scope, input.guard)
        : await moduleDef.delete!(recordId!, tenantId, scope);
      if (!result) return notFound();
    }
  } catch (opErr) {
    // A service error's own HTTP status when it carries one (Customer's
    // linked-records delete guard: 409; StaleWriteError: 409). The
    // version-token modules throw a named VersionError (no statusCode).
    const isVersionConflict = (opErr as any).name === 'VersionError';
    const statusCode = isVersionConflict ? 409 : ((opErr as any).statusCode ?? 400);
    await writeNativeCrmLog({
      tenantId, actorId: userId, actorName, actorRole: identity.role ?? '',
      action: 'error', module: moduleDef.logModule, resourceId: recordId ?? '',
      error: (opErr as Error).message, statusCode, url, origin: 'assistant',
    }).catch(() => {});
    return { ok: false, status: statusCode, message: (opErr as Error).message, kind: 'service', error: opErr };
  }

  // The before state: the record as read before the write (update/delete),
  // or what the delete returned. No extra read is made for it.
  const before = operation === 'create'
    ? null
    : logSnapshot(current ?? stampedBefore ?? (operation === 'delete' && typeof result === 'object' ? result : null));
  await writeNativeCrmLog({
    tenantId, actorId: userId, actorName, actorRole: identity.role ?? '',
    action: operation, module: moduleDef.logModule,
    resourceId: String(result?._id ?? recordId ?? ''),
    before,
    after: operation !== 'delete' ? (result?.toObject ? result.toObject() : result) : null,
    changes: operation === 'update' ? (data ?? null) : null,
    statusCode: 200, url, origin: 'assistant',
  }).catch(() => {});

  // The post-save steps, after the write and OUTSIDE the
  // assistant-provenance scope, so they never set or clear a reminder
  // marker. A failing step never changes the outcome: it is logged (warn;
  // error for Lead, whose screen answers 400 after saving).
  if (writeHooks) {
    try {
      if (operation === 'create') await writeHooks.afterCreate?.(hookCtx, result);
      else if (operation === 'update') await writeHooks.afterUpdate?.(hookCtx, result, prev, updatePayload);
      else await writeHooks.afterDelete?.(hookCtx, result, recordObjectId(result) ?? recordId!);
    } catch (hookErr) {
      logger[writeHooks.afterWriteFailureLevel]('CRM assistant post-save step failed (the write itself succeeded)', {
        tenantId, module, operation, userId,
        resourceId: recordObjectId(result) ?? recordId ?? '', error: (hookErr as Error)?.message,
      });
    }
  }

  // Never the raw record (PII ciphertext — or plaintext where an update
  // path skips encryption — plus system fields and app credentials). A
  // create or update answers with exactly what GET /crm-get gives this
  // caller; a delete with the id only. The write has already happened, so a
  // failure here never turns it into an error — the id alone is sent.
  const recordIdOut = recordObjectId(result) ?? recordId;
  let responseData: Record<string, unknown> = { _id: recordIdOut };
  if (operation !== 'delete') {
    try {
      const [piiSafe] = await applyPIIProtection([result], moduleDef.logModule, tenantId, identity.branchId, identity.role ?? 'AGENT');
      responseData = projectForDetail(piiSafe, moduleDef, input.writable);
    } catch { /* keep the id-only response */ }
  }
  // Contact: an existing contact has the same email or phone. Generic —
  // never the other contact's name or id.
  if (duplicateWarning) responseData.duplicateWarning = duplicateWarning;
  return { ok: true, result, recordId: String(recordIdOut ?? ''), responseData };
}
