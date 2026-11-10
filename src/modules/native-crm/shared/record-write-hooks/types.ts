/** Phase 2 (Part A) — the INTERNAL post-save steps of a record write, shared
 * so the CRM assistant gateway (POST /api/internal/crm-write) runs the same
 * steps the screen controllers run: timeline entries, delete audits,
 * duplicate checks, Lead lastActivityAt / team re-resolution and the
 * invoice-paid / work-order-completed auto-lock.
 *
 * Never part of this module: automations (runAutomations*), on-create
 * confirmations or any other message, PII masking / response shaping, and
 * error-to-status mapping. Those stay where they are.
 *
 * Each <module>.hooks.ts imports exactly the dependency paths its screen
 * controller imports, and holds the controller's own code as small step
 * functions. A step called with origin 'screen' produces exactly the
 * controller's values; origin 'assistant' only adds the chat marker
 * ({ via: 'assistant' } in timeline metadata / audit detail).
 *
 * This file has no runtime imports. */

import type { logAuditEvent } from '../../../logs/audit-log.model';

export type WriteOrigin = 'screen' | 'assistant';

/** The audit actor shape logAuditEvent takes: { id, email, role, ip?, userAgent? }. */
export type AuditActor = Parameters<typeof logAuditEvent>[1];

export interface RecordWriteHookContext {
  tenantId: string;
  /** The acting user. On the gateway: the verified identity's userId. */
  userId: string | undefined;
  origin: WriteOrigin;
  /** Resolves the audit actor. Called only when a delete audit is written. */
  getAuditActor(): Promise<AuditActor>;
  /** Rejection handler for a fire-and-forget step (`.catch(...)`). The
   * screens swallow these silently; the gateway logs a warning. */
  swallow(step: string): (err: unknown) => void;
}

export interface BeforeCreateResult {
  /** Refuse the create (nothing is written). */
  block?: { status: 409; message: string };
  /** The create goes ahead; this note goes back with the response. */
  warning?: string;
  /** Server-side fields added to the create payload. */
  extraFields?: Record<string, unknown>;
}

export interface RecordWriteHooks {
  /** Whether this update's steps use the record as it was before the write
   * (the screens always read it; for these modules it only changes what is
   * logged when the body has the key named per module, so an update without
   * it needs no extra read). */
  needsPrevOnUpdate(payload: Record<string, unknown>): boolean;
  /** How a failure of an awaited after-write step is logged. */
  afterWriteFailureLevel: 'warn' | 'error';
  /** Runs before the create and before anything is written. */
  beforeCreate?(ctx: RecordWriteHookContext, data: Record<string, unknown>): Promise<BeforeCreateResult>;
  /** Runs before the update. It may add server-side keys to `payload`,
   * the object that is then written. */
  beforeUpdate?(ctx: RecordWriteHookContext, prev: any, payload: Record<string, unknown>): Promise<void>;
  afterCreate?(ctx: RecordWriteHookContext, record: any): Promise<void>;
  afterUpdate?(ctx: RecordWriteHookContext, record: any, prev: any, payload: Record<string, unknown>): Promise<void>;
  /** `entityId` stands in for the screen's req.params.id: the record's
   * real _id (or the id the caller used when the record has none). */
  afterDelete?(ctx: RecordWriteHookContext, record: any, entityId: string): Promise<void>;
}

/** userAgent of every audit entry the CRM assistant writes. */
export const ASSISTANT_USER_AGENT = 'crm-assistant';

/** Generic duplicate messages for the assistant. They never name or point to
 * the other record (the screens' messages do; those are unchanged). */
export const LEAD_DUPLICATE_MESSAGE = 'A lead with the same email or phone already exists.';
export const CUSTOMER_DUPLICATE_MESSAGE = 'A customer with the same email or phone already exists.';
export const CONTACT_DUPLICATE_WARNING = 'A contact with the same email or phone already exists.';

/** The assistant's answer (503) when a check that must run before the write
 * fails (duplicate lookup, Lead team lookup). Nothing is written. */
export const CREATE_PRECHECK_FAILED_MESSAGE =
  "Couldn't check for an existing record with the same email or phone right now, so nothing was saved. Please try again in a moment.";
export const UPDATE_PRECHECK_FAILED_MESSAGE =
  "Couldn't prepare this change right now, so nothing was saved. Please try again in a moment.";

/** Timeline metadata / audit detail as each origin writes it: the screen's
 * value untouched (same reference, undefined stays undefined); the
 * assistant's with { via: 'assistant' } added. */
export function withOrigin(value: Record<string, any> | undefined, origin: WriteOrigin): Record<string, any> | undefined {
  return origin === 'assistant' ? { ...(value ?? {}), via: 'assistant' } : value;
}
