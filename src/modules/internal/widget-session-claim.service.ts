import mongoose from 'mongoose';
import { WidgetSessionClaim } from './widget-session-claim.model';

const POLL_INTERVAL_MS = 150;
const POLL_MAX_ATTEMPTS = 20; // ~3s worst case for a genuinely slow concurrent winner

// .lean() returns a plain object, not a Mongoose Document — a separate,
// narrower type for exactly the fields callers actually read (rather than
// casting to the full IWidgetSessionClaimDoc, which was a real TS error:
// `current` here is missing every Document/MongoClient-internal member).
export interface WidgetSessionClaimOutcome {
  status: 'pending' | 'done';
  result?: Record<string, unknown>;
}

/** Atomically claims (tenantId, sessionId, kind) — the caller that gets
 * `claimed: true` back is the ONE, sole owner of doing the real work for this
 * session; every other concurrent caller for the identical session gets
 * `claimed: false` and should build its response from the polled outcome
 * instead of repeating the work. See widget-session-claim.model.ts for why a
 * plain findOne-then-create check is unsafe here.
 *
 * A losing caller whose winner then RELEASES the claim (a retryable failure —
 * see releaseWidgetSessionClaim below) re-attempts its own claim immediately
 * rather than idly polling for a 'done' status that will never arrive once
 * the document is gone — this is what makes "10 concurrent requests, the
 * winner's attempt fails, someone should still succeed" behave sanely instead
 * of every caller giving up. Bounded by POLL_MAX_ATTEMPTS total across all
 * such re-attempts combined, not per-attempt, so this can never loop forever. */
export async function claimWidgetSession(
  tenantId: string, sessionId: string, kind: 'lead' | 'meeting',
): Promise<{ claimed: true } | { claimed: false; outcome: WidgetSessionClaimOutcome | null }> {
  const tid = new mongoose.Types.ObjectId(tenantId);

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const previous = await WidgetSessionClaim.findOneAndUpdate(
      { tenantId: tid, sessionId, kind },
      { $setOnInsert: { tenantId: tid, sessionId, kind, status: 'pending' } },
      { upsert: true, new: false },
    );
    if (!previous) return { claimed: true }; // no prior document existed — we're the one doing the work

    // Someone else already holds (or held) this claim — poll it briefly.
    const current = await WidgetSessionClaim.findOne({ tenantId: tid, sessionId, kind }).select('status result').lean();
    if (current?.status === 'done') return { claimed: false, outcome: { status: 'done', result: current.result } };
    if (!current) continue; // released between our upsert and our read — try claiming it ourselves now
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { claimed: false, outcome: null }; // exhausted the poll/retry budget
}

/** Call on genuine, permanent success only — this is what makes a later
 * duplicate/retried request for the same session correctly no-op instead of
 * repeating the work. */
export async function resolveWidgetSessionClaim(
  tenantId: string, sessionId: string, kind: 'lead' | 'meeting', result: Record<string, unknown>,
): Promise<void> {
  await WidgetSessionClaim.updateOne(
    { tenantId: new mongoose.Types.ObjectId(tenantId), sessionId, kind },
    { $set: { status: 'done', result } },
  );
}

/** Call on any RETRYABLE outcome (a slot just got taken, lead validation
 * failed, a duplicate-key race on the final write) — releases the claim so
 * the same visitor can immediately try again within the same conversation
 * instead of being permanently locked out after one failed attempt. */
export async function releaseWidgetSessionClaim(
  tenantId: string, sessionId: string, kind: 'lead' | 'meeting',
): Promise<void> {
  await WidgetSessionClaim.deleteOne({ tenantId: new mongoose.Types.ObjectId(tenantId), sessionId, kind });
}
