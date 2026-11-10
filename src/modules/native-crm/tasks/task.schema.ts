import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';
import { registerAssistantProvenanceHooks } from '../shared/assistant-provenance';

export const taskSchema = new Schema(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:   { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:   { type: String, index: true },
    title:      { type: String, required: true, trim: true },
    dueDate:    { type: Date },
    priority:   { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    // Stage validity is enforced at the service layer against the tenant's
    // own configured pipeline (native-crm/pipeline-config), not a fixed enum.
    taskStatus: { type: String, default: 'todo' },
    assignedTo: { type: String, trim: true },
    notes:      { type: String },
    tags:       [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:  { type: String },
    // Optional link to a real Field Service record (Customer/Quotation/Work
    // Order/Contract) so this task shows up in that record's Activity feed —
    // relatedId is the target's Mongo _id (not its human-facing *Id string),
    // matching the same convention already used by lead-conversion/Timeline.
    relatedModule: { type: String, enum: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract', 'lead'] },
    relatedId:     { type: String, trim: true },
    relatedLabel:  { type: String, trim: true },
    // Guard so the "upcoming task" reminder cron never emails/texts twice for
    // the same task — same shape as Call/Meeting's reminderSentAt.
    reminderSentAt: { type: Date },
    // CRM-assistant reminder pause (shared/assistant-provenance.ts): set only
    // by the internal CRM assistant gateway, in the same write, when it creates
    // the task or changes a reminder-relevant field. While the task's
    // reminder-relevant values still match the fingerprint, the reminder cron
    // sends nothing to the customer. Server-managed and internal: no default
    // (absent unless paused), never selected unless asked for, and dropped
    // from toJSON/toObject.
    assistantChangedAt:   { type: Date, select: false },
    assistantFingerprint: { type: String, select: false },
    // The reminder cron already logged "not sent" for the current pause.
    reminderSuppressedAt: { type: Date, select: false },
  },
  { timestamps: true }
);

registerAssistantProvenanceHooks(taskSchema, 'task');

taskSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

taskSchema.index({ tenantId: 1 });
taskSchema.index({ tenantId: 1, taskStatus: 1 });
taskSchema.index({ tenantId: 1, dueDate: 1 });
taskSchema.index({ tenantId: 1, priority: 1 });
taskSchema.index({ tenantId: 1, relatedModule: 1, relatedId: 1 });
