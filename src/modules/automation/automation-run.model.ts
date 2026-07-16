import { Schema, model, Document, Types } from 'mongoose';

export type AutomationStepStatus = 'pending' | 'success' | 'failed' | 'skipped';
export type AutomationRunStatus  = 'running' | 'completed' | 'partial' | 'failed';

export interface IAutomationStep {
  name:        string;
  status:      AutomationStepStatus;
  result?:     string;
  error?:      string;
  executedAt?: Date;
  messageContent?: {
    subject?: string; // email subject
    body?:    string; // email HTML body
    text?:    string; // SMS / WhatsApp plain text
    to?:      string; // recipient email or phone
  };
}

export interface IAutomationRun extends Document {
  tenantId:      Types.ObjectId;
  sessionId:     string;
  trigger:       string;
  triggerType:   'chat' | 'manual';
  customerName:  string;
  customerId?:   string;
  customerEmail?: string;
  customerPhone?: string;
  status:        AutomationRunStatus;
  steps:         IAutomationStep[];
  activityId?:   string;
  createdAt:     Date;
  updatedAt:     Date;
}

const stepSchema = new Schema<IAutomationStep>(
  {
    name:           { type: String, required: true },
    status:         { type: String, enum: ['pending', 'success', 'failed', 'skipped'], default: 'pending' },
    result:         String,
    error:          String,
    executedAt:     Date,
    messageContent: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

const automationRunSchema = new Schema<IAutomationRun>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sessionId:     { type: String, required: true },
    trigger:       { type: String, required: true },
    triggerType:   { type: String, enum: ['chat', 'manual'], default: 'chat' },
    customerName:  { type: String, default: 'Unknown' },
    customerId:    String,
    customerEmail: String,
    customerPhone: String,
    status:        { type: String, enum: ['running', 'completed', 'partial', 'failed'], default: 'running' },
    steps:         { type: [stepSchema], default: [] },
    activityId:    String,
  },
  { timestamps: true }
);

automationRunSchema.index({ tenantId: 1, createdAt: -1 });
automationRunSchema.index({ tenantId: 1, status: 1 });

export const AutomationRun = model<IAutomationRun>('AutomationRun', automationRunSchema);
