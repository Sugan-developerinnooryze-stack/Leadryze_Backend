import {
  CrmAssistOperation, CrmAssistOperationDoc, OperationStatus, EXECUTING_STUCK_MS, PURGE_AFTER_MS,
} from './operation.model';
import { auditOperationStep } from './audit';
import { logger } from '../../../utils/logger';

/* Moves open operations (a guided form's draft, a staged change) past their
 * expiry to 'expired', and an operation stuck in 'executing' (a confirm that
 * never finished) to 'unknown', each with its audit entry. TTL deletion runs
 * no code, so this sweep is what writes those lifecycle entries; it runs
 * every 5 minutes (scheduler.service.ts), and Confirm / Cancel / Status (and
 * the guided-form steps) apply the same transitions to the one operation
 * they touch. */

export const UNKNOWN_OUTCOME_MESSAGE =
  "It isn't certain whether this change was saved. Check the record before trying again.";

/** At most this many operations per state and run. */
const SWEEP_BATCH = 500;

/** The states an operation can still be cancelled, expired or superseded
 * from: a guided form's draft (Increment 6) and a staged change. */
export const OPEN_OPERATION_STATUSES: readonly OperationStatus[] = ['staged', 'draft'];

/** Moves one operation from `from` (one status, or any of several) to the
 * status in `set`, atomically (the filter includes the current status).
 * Null when it was no longer in `from`. */
export async function transitionOperation(
  id: string, from: OperationStatus | readonly OperationStatus[], set: Partial<CrmAssistOperationDoc>, extraFilter: Record<string, unknown> = {},
): Promise<CrmAssistOperationDoc | null> {
  return CrmAssistOperation.findOneAndUpdate(
    { _id: id, status: typeof from === 'string' ? from : { $in: [...from] }, ...extraFilter },
    { $set: set },
    { new: true },
  ).lean() as Promise<CrmAssistOperationDoc | null>;
}

const purgeAtFrom = (now: Date) => new Date(now.getTime() + PURGE_AFTER_MS);

/** draft or staged -> expired when its expiry has passed; audits it. */
export async function expireIfDue(id: string, now: Date = new Date()): Promise<CrmAssistOperationDoc | null> {
  const expired = await transitionOperation(id, OPEN_OPERATION_STATUSES, { status: 'expired', purgeAt: purgeAtFrom(now) }, { expiresAt: { $lte: now } });
  if (expired) await auditOperationStep(expired, 'expired');
  return expired;
}

/** executing -> unknown (a confirm that may or may not have written); audits it. */
export async function markUnknown(id: string, now: Date = new Date(), extraFilter: Record<string, unknown> = {}): Promise<CrmAssistOperationDoc | null> {
  const unknown = await transitionOperation(id, 'executing', {
    status: 'unknown', purgeAt: purgeAtFrom(now), error: { code: 'unknown', message: UNKNOWN_OUTCOME_MESSAGE },
  }, extraFilter);
  if (unknown) await auditOperationStep(unknown, 'unknown');
  return unknown;
}

/** True when an executing operation has been claimed for longer than the limit. */
export function isStuckExecuting(doc: Pick<CrmAssistOperationDoc, 'status' | 'claimedAt'>, now: Date = new Date()): boolean {
  if (doc.status !== 'executing' || !doc.claimedAt) return false;
  return now.getTime() - new Date(doc.claimedAt).getTime() > EXECUTING_STUCK_MS;
}

export async function sweepCrmAssistOperations(now: Date = new Date()): Promise<{ expired: number; unknown: number }> {
  let expired = 0;
  let unknown = 0;

  const due = await CrmAssistOperation.find({ status: { $in: [...OPEN_OPERATION_STATUSES] }, expiresAt: { $lte: now } })
    .select('_id').limit(SWEEP_BATCH).lean() as Array<{ _id: string }>;
  for (const { _id } of due) {
    if (await expireIfDue(_id, now)) expired += 1;
  }

  const stuckSince = new Date(now.getTime() - EXECUTING_STUCK_MS);
  const stuck = await CrmAssistOperation.find({ status: 'executing', claimedAt: { $lt: stuckSince } })
    .select('_id').limit(SWEEP_BATCH).lean() as Array<{ _id: string }>;
  for (const { _id } of stuck) {
    if (await markUnknown(_id, now, { claimedAt: { $lt: stuckSince } })) unknown += 1;
  }

  if (expired || unknown) logger.info('CRM assist operations sweep', { expired, unknown });
  return { expired, unknown };
}
