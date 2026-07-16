import mongoose, { Schema, Document } from 'mongoose';

export type AIActionType =
  | 'crm_query'     // AI fetched CRM records
  | 'crm_filter'    // AI fetched + filtered records (price < 1000)
  | 'crm_search'    // AI searched across records by keyword
  | 'lead_capture'  // AI captured a visitor lead (name/email/phone)
  | 'knowledge_query' // AI answered from knowledge base (RAG)
  | 'escalation'    // AI escalated to human agent
  | 'email_sent'    // AI triggered an email
  | 'error'         // AI encountered an error
  | 'general';      // General chat response

export interface IAIAction extends Document {
  tenantId: mongoose.Types.ObjectId;
  sessionId: string;
  actionType: AIActionType;
  summary: string;
  userMessage: string;
  metadata: {
    channel?: string;
    module?: string;
    recordCount?: number;
    filterExpression?: string;
    filteredCount?: number;
    leadName?: string;
    leadEmail?: string;
    leadPhone?: string;
    errorMessage?: string;
  };
  createdAt: Date;
}

const aiActionSchema = new Schema<IAIAction>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sessionId:   { type: String, required: true, index: true },
    actionType:  {
      type: String,
      enum: ['crm_query', 'crm_filter', 'crm_search', 'lead_capture',
             'knowledge_query', 'escalation', 'email_sent', 'error', 'general',
             'schedule_meeting', 'reschedule_meeting', 'cancel_meeting',
             'send_email', 'send_sms', 'meeting_reminder'],
      default: 'general',
    },
    summary:     { type: String, required: true },
    userMessage: { type: String, default: '' },
    metadata:    { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

// Auto-expire after 90 days (same as chat sessions)
aiActionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AIAction = mongoose.model<IAIAction>('AIAction', aiActionSchema);
