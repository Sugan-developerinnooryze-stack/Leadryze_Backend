import mongoose, { Schema, Document } from 'mongoose';

/**
 * Per-tenant, daily-bucketed LLM token/cost counters — mirrors
 * service-usage.model.ts's exact atomic-upsert shape (proven pattern for
 * Brevo/Twilio send counts), just tenant-scoped instead of provider-scoped.
 * No TTL/auto-expiry — unlike ServiceUsage, this is the data the Super Admin
 * usage dashboard reads and a tenant's monthly quota is computed from, so
 * it's kept indefinitely rather than rolled off after 90 days.
 */
export interface IAiTokenUsage extends Document {
  tenantId: mongoose.Types.ObjectId;
  date: string; // 'YYYY-MM-DD' — one doc per tenant per day
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
  moderationFallbackCount: number;
}

const aiTokenUsageSchema = new Schema<IAiTokenUsage>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    date: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
    requestCount: { type: Number, default: 0 },
    moderationFallbackCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

aiTokenUsageSchema.index({ tenantId: 1, date: 1 }, { unique: true });
aiTokenUsageSchema.index({ tenantId: 1, createdAt: -1 });

export const AiTokenUsage = mongoose.model<IAiTokenUsage>('AiTokenUsage', aiTokenUsageSchema);

/** Increment today's counters for a tenant. Never throws — usage tracking
 * must never be able to break a real chat response. */
export async function trackAiTokenUsage(
  tenantId: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number; usedModerationFallback?: boolean }
): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    await AiTokenUsage.findOneAndUpdate(
      { tenantId, date },
      {
        $inc: {
          promptTokens: usage.promptTokens || 0,
          completionTokens: usage.completionTokens || 0,
          totalTokens: usage.totalTokens || 0,
          estimatedCostUsd: usage.estimatedCostUsd || 0,
          requestCount: 1,
          moderationFallbackCount: usage.usedModerationFallback ? 1 : 0,
        },
      },
      { upsert: true }
    );
  } catch { /* never crash the app */ }
}

/** Sum of totalTokens for a tenant so far this calendar month — the source
 * of truth checkTenantTokenQuota() in the AI service caches briefly in Redis. */
export async function getTenantTokenUsageThisMonth(tenantId: string): Promise<number> {
  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const result = await AiTokenUsage.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), date: { $gte: monthStart } } },
    { $group: { _id: null, totalTokens: { $sum: '$totalTokens' } } },
  ]);
  return result[0]?.totalTokens ?? 0;
}
