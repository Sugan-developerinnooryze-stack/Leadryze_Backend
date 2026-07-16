import mongoose, { Schema, Document } from 'mongoose';

export interface IServiceUsage extends Document {
  provider: string;  // 'brevo', 'twilio', etc.
  date: string;      // 'YYYY-MM-DD' — one doc per provider per day
  sent: number;
  failed: number;
}

const serviceUsageSchema = new Schema<IServiceUsage>(
  {
    provider: { type: String, required: true },
    date:     { type: String, required: true },
    sent:     { type: Number, default: 0 },
    failed:   { type: Number, default: 0 },
  },
  { timestamps: true }
);

serviceUsageSchema.index({ provider: 1, date: 1 }, { unique: true });
// Auto-delete after 90 days
serviceUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const ServiceUsage = mongoose.model<IServiceUsage>('ServiceUsage', serviceUsageSchema);

/** Increment the daily counter for a provider. Never throws. */
export async function trackServiceUsage(provider: string, success: boolean): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    await ServiceUsage.findOneAndUpdate(
      { provider, date },
      { $inc: { sent: success ? 1 : 0, failed: success ? 0 : 1 } },
      { upsert: true }
    );
  } catch { /* never crash the app */ }
}
