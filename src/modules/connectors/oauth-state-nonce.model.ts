import mongoose, { Schema, Document } from 'mongoose';

/** Single-use guard for the OAuth connector `state` param
 * (connector-oauth.controller.ts) — modeled directly on
 * automation-webhooks/webhook-delivery.model.ts's own fingerprint pattern.
 * A state JWT's signature/expiry alone doesn't stop the SAME valid
 * `?state=...&code=...` callback URL from being replayed a second time
 * within its 10-minute window (e.g. an intercepted redirect URL, or a
 * browser back-button resubmission) — the first callback to consume a
 * given nonce wins (unique index below); any replay hits a duplicate-key
 * error and is rejected rather than re-running the token exchange /
 * connector creation a second time. TTL matches the state token's own
 * expiry, so a nonce can never outlive the token that carried it. */
export interface IOAuthStateNonce extends Document {
  nonce: string;
  createdAt: Date;
}

const schema = new Schema<IOAuthStateNonce>(
  {
    nonce: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const OAuthStateNonce = mongoose.model<IOAuthStateNonce>(
  'OAuthStateNonce',
  schema,
  'native_oauth_state_nonces',
);
