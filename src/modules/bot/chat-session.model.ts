import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: { escalated?: boolean; provider?: string; model?: string };
}

export interface IChatSession extends Document {
  tenantId: mongoose.Types.ObjectId;
  sessionId: string;
  visitorName?: string;
  visitorEmail?: string;
  visitorPhone?: string;
  channel: string;
  messages: IChatMessage[];
  escalated: boolean;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const chatMessageSchema = new Schema<IChatMessage>(
  {
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata:  { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const chatSessionSchema = new Schema<IChatSession>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sessionId:    { type: String, required: true, unique: true, index: true },
    visitorName:  { type: String },
    visitorEmail: { type: String },
    visitorPhone: { type: String },
    channel:      { type: String, default: 'web' },
    messages:     [chatMessageSchema],
    escalated:    { type: Boolean, default: false },
    closedAt:     { type: Date },
  },
  { timestamps: true }
);

// Auto-delete sessions after 90 days
chatSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ChatSession = mongoose.model<IChatSession>('ChatSession', chatSessionSchema);
