import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  tenantId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  sessionId: string;
  channel: 'web' | 'whatsapp' | 'instagram' | 'email' | 'phone';
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'template';
  content: string;
  mediaUrl?: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  aiGenerated: boolean;
  metadata: Record<string, unknown>;
  externalMessageId?: string;
}

const messageSchema = new Schema<IMessage>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    sessionId: { type: String, required: true },
    channel: { type: String, enum: ['web', 'whatsapp', 'instagram', 'email', 'phone'], required: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    type: {
      type: String,
      enum: ['text', 'image', 'document', 'audio', 'video', 'template'],
      default: 'text',
    },
    content: { type: String, required: true },
    mediaUrl: String,
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed'], default: 'sent' },
    aiGenerated: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: {} },
    externalMessageId: String,
  },
  { timestamps: true }
);

messageSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, sessionId: 1 });
messageSchema.index({ tenantId: 1, channel: 1, createdAt: -1 });

export const Message = mongoose.model<IMessage>('Message', messageSchema);
