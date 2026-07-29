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
export type EmailLogStatus = 'sent' | 'failed' | 'skipped';

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
  status:            EmailLogStatus;
  errorMessage?:     string;
  providerMessageId?: string;
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
    status:            { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
    errorMessage:      { type: String },
    providerMessageId: { type: String },
    sentAt:            { type: Date, default: Date.now },
  },
  { timestamps: false }
);

schema.index({ tenantId: 1, sourceModule: 1, sourceId: 1 });
schema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
schema.index({ tenantId: 1, sentAt: -1 });
schema.index({ tenantId: 1, channel: 1, kind: 1, status: 1 });

export const EmailLog = mongoose.model<IEmailLog>(
  'EmailLog',
  schema,
  'notification_email_logs'
);
