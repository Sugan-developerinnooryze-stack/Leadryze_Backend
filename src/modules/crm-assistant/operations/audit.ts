import { AuditLog, logAuditEvent } from '../../logs/audit-log.model';
import { ASSISTANT_USER_AGENT } from '../../native-crm/shared/record-write-hooks/types';
import type { CrmAssistOperationDoc } from './operation.model';

/* The lifecycle trail of a staged operation in AuditLog (90 days): one entry
 * per step, action crm_assist.op.<step>. The detail holds ids and field keys
 * only, never a value: logAuditEvent passes it through sanitizeAuditData,
 * which decrypts ciphertext, so nothing sealed may ever go in. A repeated
 * Confirm after the operation document was purged answers from the
 * 'applied' entry. Increment 6 adds 'started' (a guided form's draft is
 * created) and 'edited' (a review goes back to its form); a validate or a
 * fill writes no entry (L12). */

export const OPERATION_AUDIT_STEPS = [
  'started', 'staged', 'edited', 'confirmed', 'applied', 'failed', 'unknown', 'cancelled', 'expired', 'superseded',
] as const;
export type OperationAuditStep = typeof OPERATION_AUDIT_STEPS[number];

export const OPERATION_AUDIT_TARGET = 'CrmAssistOperation';
export const auditActionFor = (step: OperationAuditStep): string => `crm_assist.op.${step}`;

type AuditableOperation = Pick<CrmAssistOperationDoc,
  '_id' | 'tenantId' | 'userId' | 'actorEmail' | 'role' | 'module' | 'op' | 'origin' | 'revision' | 'fieldKeys' | 'result'>;

/** Exactly the detail of one step: no values, ever. */
export function auditDetailFor(op: AuditableOperation, step: OperationAuditStep): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    operationId: op._id,
    module: op.module,
    op: op.op,
    origin: op.origin,
    revision: op.revision,
    fieldKeys: [...(op.fieldKeys ?? [])],
  };
  if (step === 'applied' && op.result) {
    detail.recordId = op.result.recordId;
    if (op.result.number) detail.number = op.result.number;
  }
  return detail;
}

/** Never throws (logAuditEvent logs its own failures). */
export async function auditOperationStep(op: AuditableOperation, step: OperationAuditStep): Promise<void> {
  await logAuditEvent(
    auditActionFor(step),
    { id: op.userId, email: op.actorEmail, role: op.role, userAgent: ASSISTANT_USER_AGENT },
    { tenantId: op.tenantId, target: OPERATION_AUDIT_TARGET, targetId: op._id, detail: auditDetailFor(op, step) },
  );
}

export interface AppliedAuditEntry {
  operationId: string;
  module: string;
  op: 'create' | 'update' | 'delete';
  recordId: string;
  number?: string;
}

/** The 'applied' entry of an operation this user staged in this tenant, if
 * one was written: what a repeated Confirm or a status check answers after
 * the operation itself is gone. */
export async function findAppliedAuditEntry(tenantId: string, userId: string, operationId: string): Promise<AppliedAuditEntry | null> {
  const entry = await AuditLog.findOne({
    tenantId, actorId: userId, action: auditActionFor('applied'), targetId: operationId,
  }).sort({ timestamp: -1 }).lean() as { detail?: Record<string, unknown> } | null;
  const detail = entry?.detail;
  if (!detail || detail.operationId !== operationId || typeof detail.recordId !== 'string') return null;
  const op = detail.op === 'create' || detail.op === 'update' || detail.op === 'delete' ? detail.op : null;
  if (!op || typeof detail.module !== 'string') return null;
  return {
    operationId, module: detail.module, op, recordId: detail.recordId,
    ...(typeof detail.number === 'string' && detail.number ? { number: detail.number } : {}),
  };
}
