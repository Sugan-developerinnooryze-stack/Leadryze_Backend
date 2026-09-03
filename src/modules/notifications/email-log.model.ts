import mongoose, { Schema, Document } from 'mongoose';

// 'system' covers non-messaging automation actions (e.g. create_linked_record)
// that still want the same audit trail this log already provides.
export type EmailLogChannel = 'email' | 'sms' | 'whatsapp' | 'system';
export type EmailLogKind = 'on_create_confirmation' | 'reminder' | 'automation';
export type EmailLogSourceModule =
  | 'call' | 'meeting' | 'task' | 'ticket'
  // Automation-rule sources (Phase 3) — the same 8 tenant-configurable
  // pipeline modules as native-crm/pipeline-config.
  | 'lead' | 'deal' | 'quotation' | 'workorder' | 'contract' | 'invoice'
  // Tenant-built Custom Modules (Phase 6) — arbitrary slug, so validated at
  // the application layer rather than a fixed Mongoose enum (see schema
  // below), same tradeoff as PipelineModule.
  | `custom:${string}`;
// 'queued' is written BEFORE a send attempt (chatbot lead emails, see
// chatbot-lead-email.service.ts) so a failure is always visible as a
// terminal 'failed' row rather than nothing at all — the row this same
// call created is then updated in place to 'sent'/'failed', never a second
// row per attempt, so `attempts` below tracks retries without duplicating
// audit history.
export type EmailLogStatus = 'queued' | 'sent' | 'failed' | 'skipped';

export interface IEmailLog extends Document {
  tenantId:          mongoose.Types.ObjectId;
  channel:           EmailLogChannel;
  kind:              EmailLogKind;
  sourceModule:      EmailLogSourceModule;
  sourceId:          string;
  relatedModule?:    string;
  relatedId?:        string;
  relatedLabel?:     string;
  recipientName?:    string;
  recipientEmail?:   string;
  recipientPhone?:   string;
  subject?:          string;
  bodyPreview?:      string;
  /** Full, untruncated HTML — ONLY populated by the queued/retry-capable
   * path (chatbot-lead-email.service.ts). Every other writeLog() caller
   * leaves this unset and keeps using bodyPreview (stripped/truncated to
   * 320 chars) exactly as before — this exists specifically so a retry can
   * resend the real email, not a mangled plain-text fragment of it. */
  fullHtmlContent?:  string;
  status:            EmailLogStatus;
  errorMessage?:     string;
  providerMessageId?: string;
  /** Number of send attempts made for this row so far. Only meaningful for
   * kind:'on_create_confirmation' rows created via the queued/retry path —
   * every other existing writeLog() caller still writes a single-attempt
   * terminal row exactly as before, this field just defaults to 1 for them. */
  attempts:          number;
  sentAt:            Date;
}

const schema = new Schema<IEmailLog>(
  {
    tenantId:          { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    channel:           { type: String, enum: ['email', 'sms', 'whatsapp', 'system'], required: true },
    kind:              { type: String, enum: ['on_create_confirmation', 'reminder', 'automation'], required: true },
    // No Mongoose enum — 'custom:<slug>' values are unbounded (any tenant's
    // Custom Module), so this is validated at the application layer instead
    // (the finite set is still enforced by TypeScript's EmailLogSourceModule).
    sourceModule:      { type: String, required: true },
    sourceId:          { type: String, required: true },
    relatedModule:     { type: String },
    relatedId:         { type: String },
    relatedLabel:      { type: String },
    recipientName:     { type: String },
    recipientEmail:    { type: String },
    recipientPhone:    { type: String },
    subject:           { type: String },
    bodyPreview:       { type: String, maxlength: 320 },
    fullHtmlContent:   { type: String },
    status:            { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], required: true },
    errorMessage:      { type: String },
    providerMessageId: { type: String },
    attempts:          { type: Number, default: 1 },
    sentAt:            { type: Date, default: Date.now },
  },
  { timestamps: false }
);

schema.index({ tenantId: 1, sourceModule: 1, sourceId: 1 });
schema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
schema.index({ tenantId: 1, sentAt: -1 });
schema.index({ tenantId: 1, channel: 1, kind: 1, status: 1 });
// Cross-tenant, no tenantId prefix — the retry sweep (scheduler.service.ts)
// scans for failed rows across every tenant in one query, same shape as
// every other cross-tenant cron job in this codebase.
schema.index({ status: 1, kind: 1 });

export const EmailLog = mongoose.model<IEmailLog>(
  'EmailLog',
  schema,
  'notification_email_logs'
);
