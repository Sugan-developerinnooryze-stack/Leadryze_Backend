import mongoose, { Schema, Document } from 'mongoose';

/** Audit trail for every capture attempt made by an external client (the
 * LeadRyze browser extension, and later other capture agents) — NOT the
 * Lead itself. Deliberately a separate collection so the existing `leads/`
 * module's 5 files (model/validation/service/controller/routes) never need
 * to change: this module only ever IMPORTS `createLead()` (leads/lead.service.ts)
 * and `runAutomationsOnCreate()` (automation-rules/automation-rule.service.ts),
 * both already-exported functions called exactly the way the existing Lead
 * controller already calls them, and cross-references the created Lead's
 * `_id` — it never touches Lead's schema.
 *
 * A capture is written FIRST, status:'pending', before anything else can
 * fail — so even a capture that never produces a usable Lead (no name-shaped
 * field in the raw payload) still leaves a permanent, inspectable record of
 * the attempt. See lead-capture.service.ts's captureLeadFromExternalSource(). */

export type CapturePlatform = 'linkedin' | 'apollo' | 'website' | 'chatbot' | 'other';
export type CaptureStatus   = 'pending' | 'created' | 'failed';

export interface INormalizedCaptureFields {
  firstName?: string;
  lastName?:  string;
  email?:     string;
  phone?:     string;
  company?:   string;
  title?:     string;
}

export interface ILeadCaptureDoc extends Document {
  tenantId:  mongoose.Types.ObjectId;
  branchId?: mongoose.Types.ObjectId | null;

  platform:  CapturePlatform;
  sourceUrl: string;

  /** Verbatim payload the extension's provider extracted — unnormalized,
   * whatever shape that particular site produced. Never validated against a
   * fixed shape; normalizeCaptureRaw() does best-effort field mapping. */
  raw: Record<string, any>;
  /** The fields actually derived from `raw` and used to create the Lead —
   * absent if normalization failed to find even a usable name. */
  normalized?: INormalizedCaptureFields;

  status:         CaptureStatus;
  failureReason?: string;

  /** Set once createLead() succeeds — the authoritative link back to the
   * real Lead this capture produced. Independently queryable
   * (LeadCapture.find({leadId})) without relying on the Lead's own
   * customFields stash, which is a denormalized convenience only. */
  leadId?: mongoose.Types.ObjectId | null;

  capturedByUserId: string;
  capturedByEmail?: string;

  extensionVersion?: string;
  userAgent?: string;

  createdAt: Date;
  updatedAt: Date;
}

const normalizedSchema = new Schema<INormalizedCaptureFields>(
  {
    firstName: { type: String, trim: true },
    lastName:  { type: String, trim: true },
    email:     { type: String, trim: true },
    phone:     { type: String, trim: true },
    company:   { type: String, trim: true },
    title:     { type: String, trim: true },
  },
  { _id: false },
);

const schema = new Schema<ILeadCaptureDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },

    platform:  { type: String, enum: ['linkedin', 'apollo', 'website', 'chatbot', 'other'], required: true },
    sourceUrl: { type: String, required: true, trim: true },

    raw:        { type: Schema.Types.Mixed, required: true },
    normalized: { type: normalizedSchema },

    status:        { type: String, enum: ['pending', 'created', 'failed'], default: 'pending', required: true },
    failureReason: { type: String },

    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },

    capturedByUserId: { type: String, required: true },
    capturedByEmail:  { type: String, trim: true, lowercase: true },

    extensionVersion: { type: String, trim: true },
    userAgent:        { type: String, trim: true },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, platform: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, capturedByUserId: 1 });
schema.index({ tenantId: 1, leadId: 1 });

export const LeadCapture = mongoose.model<ILeadCaptureDoc>(
  'LeadCapture',
  schema,
  'native_lead_captures',
);
