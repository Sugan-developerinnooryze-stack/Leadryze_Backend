import mongoose, { Schema, Document } from 'mongoose';

/** A tiny, atomic "claim" collection — same shape/purpose as
 * round-robin-cursor.model.ts's own RoundRobinCursor: the actual work
 * (creating a Lead, booking a Meeting) is NOT atomic across the several
 * writes it involves, so a plain "check if one already exists, then create"
 * guard is racy under real concurrent requests for the identical session
 * (confirmed live: 10 concurrent widget-lead-capture calls for the SAME
 * sessionId produced 10 separate Leads, not 1). This collection's unique
 * index is what MongoDB itself enforces atomically — findOneAndUpdate with
 * upsert:true against a unique index guarantees exactly one caller ever
 * observes "I just created this" (a null previous-document result), even
 * under a genuine race; every other concurrent caller sees the already-
 * existing document and polls it instead of proceeding.
 *
 * Only two states matter: 'pending' (someone is currently doing the work —
 * or the doc simply exists as the claim itself) and 'done' (permanent
 * success, recorded in `result`). There's no 'failed' state — a retryable
 * outcome (slot taken, validation failure) releases the claim entirely
 * (deletes the document) via releaseWidgetSessionClaim() rather than
 * recording a failure, so the same visitor can immediately retry within the
 * same conversation instead of being permanently locked out. */
export interface IWidgetSessionClaimDoc extends Document {
  tenantId: mongoose.Types.ObjectId;
  sessionId: string;
  kind: 'lead' | 'meeting';
  status: 'pending' | 'done';
  result?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IWidgetSessionClaimDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    sessionId: { type: String, required: true },
    kind: { type: String, enum: ['lead', 'meeting'], required: true },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
    result: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, sessionId: 1, kind: 1 }, { unique: true });
// Auto-expire after a day — this is a short-lived concurrency guard, not a
// permanent record (LeadCapture/Meeting themselves are the durable audit trail).
schema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const WidgetSessionClaim = mongoose.model<IWidgetSessionClaimDoc>(
  'WidgetSessionClaim',
  schema,
  'native_widget_session_claims',
);
