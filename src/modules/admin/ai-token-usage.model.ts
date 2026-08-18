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
  /** Voice (STT/TTS) usage — additive counters alongside the LLM ones above,
   * same daily bucket, same tenant. sttSeconds is real audio duration
   * (client-measured, directional not billing-grade — see ai/src/config/
   * voice-cost.ts); ttsCharacters is the synthesized reply's length. */
  sttSeconds: number;
  ttsCharacters: number;
  voiceCostUsd: number;
  voiceRequestCount: number;
  /** Continuous, hands-free voice conversation (LiveKit) — a completely
   * separate meter from the push-to-talk fields above, reported once per
   * session (not per turn) by the voice-agent worker process, not by ai/'s
   * Express app. minutes/deepgramSttSeconds/cartesiaTtsCharacters come
   * straight from AgentSession's own real usage summary
   * (session.usage.modelUsage) at session close — real provider-reported
   * numbers, not client-measured estimates. */
  continuousVoiceMinutes: number;
  continuousVoiceSessionCount: number;
  deepgramSttSeconds: number;
  cartesiaTtsCharacters: number;
  continuousVoiceCostUsd: number;
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
    sttSeconds: { type: Number, default: 0 },
    ttsCharacters: { type: Number, default: 0 },
    voiceCostUsd: { type: Number, default: 0 },
    voiceRequestCount: { type: Number, default: 0 },
    continuousVoiceMinutes: { type: Number, default: 0 },
    continuousVoiceSessionCount: { type: Number, default: 0 },
    deepgramSttSeconds: { type: Number, default: 0 },
    cartesiaTtsCharacters: { type: Number, default: 0 },
    continuousVoiceCostUsd: { type: Number, default: 0 },
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
  usage: {
    promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number;
    usedModerationFallback?: boolean;
    sttSeconds?: number; ttsCharacters?: number; voiceCostUsd?: number; isVoiceRequest?: boolean;
  }
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
          sttSeconds: usage.sttSeconds || 0,
          ttsCharacters: usage.ttsCharacters || 0,
          voiceCostUsd: usage.voiceCostUsd || 0,
          voiceRequestCount: usage.isVoiceRequest ? 1 : 0,
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

/** Records one COMPLETED continuous-voice session's usage — called once by
 * the voice-agent worker process at session close, not per-turn (unlike
 * trackAiTokenUsage above, which is called by ai/'s Express app per LLM
 * call). Never throws — usage tracking must never be able to break a real
 * voice session's own shutdown. */
export async function trackContinuousVoiceUsage(
  tenantId: string,
  usage: { minutes: number; deepgramSttSeconds: number; cartesiaTtsCharacters: number; estimatedCostUsd: number }
): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    await AiTokenUsage.findOneAndUpdate(
      { tenantId, date },
      {
        $inc: {
          continuousVoiceMinutes: usage.minutes || 0,
          continuousVoiceSessionCount: 1,
          deepgramSttSeconds: usage.deepgramSttSeconds || 0,
          cartesiaTtsCharacters: usage.cartesiaTtsCharacters || 0,
          continuousVoiceCostUsd: usage.estimatedCostUsd || 0,
        },
      },
      { upsert: true }
    );
  } catch { /* never crash the worker */ }
}

/** Sum of continuousVoiceMinutes for a tenant so far this calendar month —
 * the source of truth checkTenantVoiceMinutesQuota() in the AI service
 * caches briefly in Redis, same pattern as getTenantTokenUsageThisMonth(). */
export async function getTenantVoiceMinutesUsageThisMonth(tenantId: string): Promise<number> {
  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const result = await AiTokenUsage.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), date: { $gte: monthStart } } },
    { $group: { _id: null, minutes: { $sum: '$continuousVoiceMinutes' } } },
  ]);
  return result[0]?.minutes ?? 0;
}
