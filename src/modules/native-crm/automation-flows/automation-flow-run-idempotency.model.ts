import mongoose, { Schema, Document } from 'mongoose';

/** Crash-safe duplicate-execution guard for executeFlow() — see that
 * function's own doc comment for the full claim/reclaim design. A record is
 * NOT itself proof a run happened cleanly; it tracks the LIFECYCLE of one
 * attempt to dispatch one trigger event so a process crash between claiming
 * the key and finishing the run doesn't permanently lose a legitimate
 * action (the gap a plain "insert once, skip on duplicate" scheme — the
 * WebhookDelivery pattern this was first modeled on — would have left
 * open). */
export interface IAutomationFlowRunIdempotency extends Document {
  tenantId: mongoose.Types.ObjectId;
  flowId: mongoose.Types.ObjectId;
  triggerEventId: string;
  status: 'processing' | 'completed' | 'failed';
  attempts: number;
  startedAt: Date;
  completedAt?: Date;
  lastError?: string;
  createdAt: Date;
}

const schema = new Schema<IAutomationFlowRunIdempotency>(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true },
    flowId:   { type: Schema.Types.ObjectId, required: true },
    triggerEventId: { type: String, required: true },
    status:    { type: String, enum: ['processing', 'completed', 'failed'], required: true },
    attempts:  { type: Number, required: true, default: 1 },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    lastError:   { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ tenantId: 1, flowId: 1, triggerEventId: 1 }, { unique: true });
// 10 min — bounds how long ANY record (completed, exhausted-failed, or
// otherwise) can keep blocking a genuinely new future event that happens to
// hash to the same key. This is not the crash-safety mechanism (the
// processing/failed/attempts state machine in executeFlow() is) — it's
// cleanup, and is intentionally far longer than STALE_PROCESSING_MS so it
// never interferes with that reclaim logic.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const AutomationFlowRunIdempotency = mongoose.model<IAutomationFlowRunIdempotency>(
  'AutomationFlowRunIdempotency', schema, 'native_automation_flow_run_idempotency',
);
