import type { Model } from 'mongoose';

/* Compare-and-set for updates and deletes. A caller that captured a record's
 * updatedAt when it showed the record (the CRM assistant's review card)
 * passes it back as expectedUpdatedAt; the write then only matches that exact
 * version, and a record changed in the meantime gives a 409 with nothing
 * written. Without the option a service behaves exactly as before. */

export interface WriteGuard {
  /** The record's updatedAt when it was reviewed. */
  expectedUpdatedAt?: Date | string;
}

export const STALE_WRITE_MESSAGE = 'This record was changed by someone else since you reviewed it. Review it again.';

export class StaleWriteError extends Error {
  readonly statusCode = 409;
  readonly code = 'stale_write';

  constructor(message: string = STALE_WRITE_MESSAGE) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

/** `filter` plus the version condition when the guard carries one. An
 * unreadable version is refused rather than ignored. */
export function withExpectedVersion<T extends Record<string, unknown>>(filter: T, guard?: WriteGuard): T {
  if (!guard?.expectedUpdatedAt) return filter;
  const at = new Date(guard.expectedUpdatedAt);
  if (Number.isNaN(at.getTime())) throw new StaleWriteError('The record version sent with this change is not valid. Review it again.');
  return { ...filter, updatedAt: at };
}

/** After a guarded write matched nothing: throws StaleWriteError when the
 * record still exists under `filter` (so only its version differed), and
 * returns quietly when it is gone, so the caller keeps its usual not-found
 * behaviour. Does nothing for an unguarded write. */
export async function throwIfStale(model: Model<any>, filter: Record<string, unknown>, guard?: WriteGuard): Promise<void> {
  if (!guard?.expectedUpdatedAt) return;
  if (await model.exists(filter)) throw new StaleWriteError();
}
