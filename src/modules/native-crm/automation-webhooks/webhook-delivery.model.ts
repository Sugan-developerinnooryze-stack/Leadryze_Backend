import mongoose, { Schema, Document } from 'mongoose';

/** Idempotency record for the public webhook receiver (automation-webhook.
 * controller.ts's trigger()) — a third-party sender that times out waiting
 * for an ack is expected, by webhook convention, to retry the SAME delivery.
 * The receiver has no delivery-id header to rely on (no universal standard
 * across senders), so a delivery is fingerprinted as
 * hash(token + raw JSON body) and de-duplicated within a short window: the
 * first delivery to insert its fingerprint wins (unique index below), any
 * retry within TTL hits a duplicate-key error and is treated as "already
 * processed, skip" rather than re-running the automation. Deliberately NOT
 * keyed by token alone (would dedupe genuinely different payloads sent to
 * the same flow) and NOT permanent (a real, distinct payload replayed after
 * the window — e.g. the same status re-sent hours later — should fire
 * again). TTL is intentionally short: this exists to absorb an at-least-once
 * sender's fast retry-on-timeout, not to build a long-lived audit trail —
 * see NativeCrmLog/SecurityEvent for that. */
export interface IWebhookDelivery extends Document {
  fingerprint: string;
  createdAt: Date;
}

const schema = new Schema<IWebhookDelivery>(
  {
    fingerprint: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL — auto-delete after 10 minutes; long enough to absorb any realistic
// sender retry-on-timeout window, short enough that a legitimately repeated
// later payload isn't silently swallowed.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const WebhookDelivery = mongoose.model<IWebhookDelivery>(
  'WebhookDelivery',
  schema,
  'native_webhook_deliveries',
);
