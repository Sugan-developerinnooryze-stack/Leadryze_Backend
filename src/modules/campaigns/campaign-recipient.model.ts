import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaignRecipient extends Document {
  tenantId: mongoose.Types.ObjectId;
  campaignId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  name?: string;
  email?: string;
  phone?: string;
  channel: 'email' | 'whatsapp' | 'sms';
  status: 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed' | 'skipped';
  providerMessageId?: string;
  errorMessage?: string;
  attempts: number;
  queuedAt?: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  repliedAt?: Date;
  failedAt?: Date;
}

const campaignRecipientSchema = new Schema<ICampaignRecipient>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    name: String,
    email: String,
    phone: String,
    channel: { type: String, enum: ['email', 'whatsapp', 'sms'], required: true },
    status: {
      type: String,
      enum: ['pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'],
      default: 'pending',
    },
    providerMessageId: String,
    errorMessage: String,
    attempts: { type: Number, default: 0 },
    queuedAt: Date,
    sentAt: Date,
    deliveredAt: Date,
    readAt: Date,
    repliedAt: Date,
    failedAt: Date,
  },
  { timestamps: true, collection: 'campaign_recipients' }
);

campaignRecipientSchema.index({ tenantId: 1, campaignId: 1, status: 1 });
campaignRecipientSchema.index({ campaignId: 1, customerId: 1 }, { unique: true });
campaignRecipientSchema.index({ providerMessageId: 1 });

export const CampaignRecipient = mongoose.model<ICampaignRecipient>('CampaignRecipient', campaignRecipientSchema);
