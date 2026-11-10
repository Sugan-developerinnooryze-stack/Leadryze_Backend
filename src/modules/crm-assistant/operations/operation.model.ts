import mongoose, { Schema } from 'mongoose';
import { randomBytes } from 'crypto';
import type { SideEffect } from '../contracts/views';

/* One change the CRM assistant proposed, staged on the server (plan 5.2).
 * It belongs to one tenant, user, chat session and branch, holds its values
 * only inside `sealed` (AES-GCM, utils/crypto.ts), and runs at most once:
 * Confirm claims it atomically (staged -> executing) before anything is
 * written. Every other field is an id, a key, a status or server-written
 * text, never a field value. TTL removes the document 24 hours after it
 * reached a final state (purgeAt); the AuditLog entries stay 90 days. */

export const OPERATION_STATUSES = [
  'draft', 'staged', 'executing', 'applied', 'failed', 'unknown', 'cancelled', 'expired', 'superseded',
] as const;
export type OperationStatus = typeof OPERATION_STATUSES[number];

/** States an operation never leaves. */
export const FINAL_STATUSES: ReadonlySet<OperationStatus> = new Set(['applied', 'failed', 'unknown', 'cancelled', 'expired', 'superseded']);

export type OperationOp = 'create' | 'update' | 'delete';
export type OperationOrigin = 'workflow' | 'legacy_propose';

/** The version captured at review: the record's updatedAt (compare-and-set
 * through the service's expectedUpdatedAt guard), or 'service' for the
 * modules whose own update checks a version token (lead, deal, contact,
 * company); that token is kept inside `sealed`. */
export type TargetVersion = { updatedAt: string } | { token: 'service' };

export interface CrmAssistOperationDoc {
  _id: string;
  tenantId: string;
  userId: string;
  /** Resolved once from the User when the operation was staged (audit parity). */
  actorEmail: string;
  /** The identity's role, for the audit actor of later steps (sweep included). */
  role: string;
  roleId: string | null;
  branchId: string | null;
  sessionId: string;
  module: string;
  op: OperationOp;
  origin: OperationOrigin;
  status: OperationStatus;
  revision: number;
  /** encrypt(JSON of a SealedPayload: operations/sealed.ts, either shape). */
  sealed: string;
  fieldKeys: string[];
  target?: { id: string; version: TargetVersion };
  payloadHash?: string;
  sideEffects: SideEffect[];
  warnings: string[];
  result?: { recordId: string; number?: string; status?: string };
  /** Server-written text only. */
  error?: { code: string; message: string };
  expiresAt: Date;
  purgeAt: Date;
  /** When Confirm claimed it (status executing). */
  claimedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Staged operations expire after 10 minutes. */
export const STAGED_TTL_MS = 10 * 60 * 1000;
/** A draft (a guided form being filled, Increment 6) expires 30 minutes
 * after its last validate, fill or edit: the expiry slides (L12), and
 * purgeAt moves with it. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;
/** A draft at this revision takes no more validates or fills (409). */
export const MAX_DRAFT_REVISIONS = 300;
/** The document is purged this long after a final state. */
export const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** An operation still 'executing' after this long is reported as unknown. */
export const EXECUTING_STUCK_MS = 2 * 60 * 1000;

/** 'op_' + 128 random bits, url-safe (matches OPERATION_ID_RE). */
export function newOperationId(): string {
  return `op_${randomBytes(16).toString('base64url')}`;
}

const SideEffectSchema = new Schema<SideEffect>(
  { kind: { type: String, required: true }, text: { type: String, required: true } },
  { _id: false },
);

const CrmAssistOperationSchema = new Schema<CrmAssistOperationDoc>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    actorEmail: { type: String, required: true },
    role: { type: String, required: true },
    roleId: { type: String, default: null },
    branchId: { type: String, default: null },
    sessionId: { type: String, required: true },
    module: { type: String, required: true },
    op: { type: String, enum: ['create', 'update', 'delete'], required: true },
    origin: { type: String, enum: ['workflow', 'legacy_propose'], required: true },
    status: { type: String, enum: OPERATION_STATUSES, required: true },
    revision: { type: Number, required: true, min: 1 },
    sealed: { type: String, required: true },
    fieldKeys: { type: [String], default: [] },
    target: {
      type: new Schema({ id: { type: String, required: true }, version: { type: Schema.Types.Mixed, required: true } }, { _id: false }),
      default: undefined,
    },
    payloadHash: { type: String },
    sideEffects: { type: [SideEffectSchema], default: [] },
    warnings: { type: [String], default: [] },
    result: {
      type: new Schema({ recordId: { type: String, required: true }, number: String, status: String }, { _id: false }),
      default: undefined,
    },
    error: {
      type: new Schema({ code: { type: String, required: true }, message: { type: String, required: true } }, { _id: false }),
      default: undefined,
    },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'crm_assist_operations' },
);

// The atomic claim and every owner lookup start from _id (unique); these
// serve the session's "supersede the previous staged change" lookup and the
// expiry sweep.
CrmAssistOperationSchema.index({ tenantId: 1, userId: 1, sessionId: 1, status: 1 });
CrmAssistOperationSchema.index({ status: 1, expiresAt: 1 });
CrmAssistOperationSchema.index({ status: 1, claimedAt: 1 });
// TTL: the whole document goes 24 h after a final state.
CrmAssistOperationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const CrmAssistOperation = mongoose.model<CrmAssistOperationDoc>('CrmAssistOperation', CrmAssistOperationSchema);
