import mongoose, { Schema, Document } from 'mongoose';

/** Per-tenant settings for the internal CRM Assistant's own chat panel
 * (ChatWidget.tsx), edited in Settings → CRM Chatbot. Separate from the
 * Super-Admin-owned Tenant.aiConfig / featureFlags.bot_enabled, and from the
 * public chatbot widget's settings. A tenant with no document here gets the
 * defaults (the feature switches on, guided forms off, the built-in
 * suggested questions). */
export interface ICrmAssistantQuestion {
  _id: mongoose.Types.ObjectId;
  text: string;
}

export interface ICrmAssistantSettings extends Document {
  tenantId: mongoose.Types.ObjectId;
  /** Daily Events button + view inside the assistant. */
  dailyEventsEnabled: boolean;
  /** Custom Module builder button + view inside the assistant. */
  customModuleEnabled: boolean;
  /** Tables, number tiles and record cards under the assistant's replies
   * (the reply text is always shown). */
  visualAnswersEnabled: boolean;
  /** Guided forms: create, change and delete records from the chat with a
   * form and a review card (Increment 6). Off until an admin turns it on
   * (D15); it takes effect only with Visual answers on and the engine On. */
  workflowsEnabled: boolean;
  /** false = the built-in suggested questions are shown. */
  questionsCustomized: boolean;
  suggestedQuestions: ICrmAssistantQuestion[];
  /** Bumped on every question-list save; a save based on an older list is refused (409). */
  questionsRevision: number;
  /** Daily Events: a lead with no activity for this many days is 'stuck'. */
  staleLeadDays: number;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const questionSchema = new Schema<ICrmAssistantQuestion>(
  { text: { type: String, required: true, trim: true, maxlength: 150 } },
);

const schema = new Schema<ICrmAssistantSettings>(
  {
    tenantId:            { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    dailyEventsEnabled:  { type: Boolean, default: true },
    customModuleEnabled: { type: Boolean, default: true },
    visualAnswersEnabled: { type: Boolean, default: true },
    workflowsEnabled:    { type: Boolean, default: false },
    questionsCustomized: { type: Boolean, default: false },
    suggestedQuestions:  { type: [questionSchema], default: [] },
    questionsRevision:   { type: Number, default: 0 },
    staleLeadDays:       { type: Number, default: 7, min: 1, max: 90 },
    updatedBy:           { type: String },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1 }, { unique: true });

export const CrmAssistantSettings = mongoose.model<ICrmAssistantSettings>(
  'CrmAssistantSettings',
  schema,
  'crm_assistant_settings'
);
