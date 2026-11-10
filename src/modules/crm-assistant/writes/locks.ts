import mongoose, { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { logger } from '../../../utils/logger';

/* A short mutex around Confirm's re-check and write (Increment 7, spec B6.4,
 * M18): an invoice made from a work order holds `<tenantId>:invoice_from_wo:
 * <WO number>` while its eligibility is checked again and createInvoice runs,
 * so two chat Confirms for the same work order never both write. The _id is
 * deterministic, so it is unique with no new unique index; the TTL index
 * removes a lock its holder never released, and a lock past its expiry that
 * the TTL monitor hasn't removed yet is taken over by the next Confirm. A
 * screen create is not covered: the applied result says when one raced it
 * (afterApply). */

export interface WriteLockKey { tenantId: string; kind: 'invoice_from_wo'; key: string }

/** A lock held longer than this is taken over by the next Confirm. */
export const WRITE_LOCK_TTL_MS = 90_000;

export interface CrmAssistWriteLockDoc {
  /** `<tenantId>:<kind>:<key>`. */
  _id: string;
  tenantId: string;
  kind: 'invoice_from_wo';
  key: string;
  /** The operation id that holds it. */
  holder: string;
  expiresAt: Date;
}

const CrmAssistWriteLockSchema = new Schema<CrmAssistWriteLockDoc>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    kind: { type: String, enum: ['invoice_from_wo'], required: true },
    key: { type: String, required: true },
    holder: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'crm_assist_write_locks' },
);

// TTL: a lock goes once it has expired, held or not.
CrmAssistWriteLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CrmAssistWriteLock: Model<CrmAssistWriteLockDoc> =
  mongoose.model<CrmAssistWriteLockDoc>('CrmAssistWriteLock', CrmAssistWriteLockSchema);

/** MongoDB's duplicate-key error: the lock's _id is taken. */
const DUPLICATE_KEY = 11000;

function lockIdOf(k: WriteLockKey): string {
  return `${k.tenantId}:${k.kind}:${k.key}`;
}

/** Takes the lock for `holder` (an operation id) until now + WRITE_LOCK_TTL_MS: true when taken, false when
 * another holder has it and it hasn't expired. Any error but a duplicate key is thrown (nothing is taken). */
export async function acquireWriteLock(k: WriteLockKey, holder: string, now: Date = new Date()): Promise<boolean> {
  const _id = lockIdOf(k);
  const expiresAt = new Date(now.getTime() + WRITE_LOCK_TTL_MS);
  try {
    await CrmAssistWriteLock.create({ _id, tenantId: k.tenantId, kind: k.kind, key: k.key, holder, expiresAt });
    return true;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== DUPLICATE_KEY) throw err;
  }
  // Held. Only an expired lock is taken over (one the TTL monitor hasn't removed yet); a live one stays its holder's.
  const taken: unknown = await CrmAssistWriteLock.findOneAndUpdate(
    { _id, expiresAt: { $lte: now } }, { $set: { holder, expiresAt } }, { new: true },
  );
  return !!taken;
}

/** Gives the lock back, only if `holder` still has it. A failure is logged with ids only and never thrown: the
 * lock then expires on its own. */
export async function releaseWriteLock(k: WriteLockKey, holder: string): Promise<void> {
  try {
    await CrmAssistWriteLock.deleteOne({ _id: lockIdOf(k), holder });
  } catch {
    logger.warn('CRM assist: a write lock could not be released', { tenantId: k.tenantId, kind: k.kind, holder });
  }
}

/** Runs `fn` while holding the lock and gives it back afterwards, also when `fn` throws; busy when another
 * holder has it (fn never runs). */
export async function withWriteLock<T>(k: WriteLockKey, holder: string, fn: () => Promise<T>, now?: Date):
  Promise<{ ok: true; value: T } | { ok: false; busy: true }> {
  if (!(await acquireWriteLock(k, holder, now))) return { ok: false, busy: true };
  try {
    return { ok: true, value: await fn() };
  } finally {
    await releaseWriteLock(k, holder);
  }
}
