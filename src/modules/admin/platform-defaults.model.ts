import mongoose, { Schema, Document } from 'mongoose';
import { IFeatureFlags, DEFAULT_FEATURE_FLAGS, featureFlagsSchemaFields, PlanTier } from '../tenants/tenant.model';

// Singleton — exactly one document, fixed _id so upsert always targets the
// same row. This is the Super-Admin-editable template new tenants inherit
// at creation time (see provisionTenant()/registerUser()), and what a
// tenant on accessConfigMode:'default' resolves its effective flags from.
const SINGLETON_ID = 'platform-defaults';

export interface IAiPlanDefaults {
  monthlyTokenLimit: number;
  monthlyVoiceMinutesLimit: number;
  /** What this plan is billed at — reference/context for Super Admin only,
   * not wired into any billing system. */
  priceUsdPerMonth: number;
}

// Seed values — the same per-plan token/voice-minute numbers that used to
// be hardcoded independently in tenant.service.ts, admin.routes.ts, and
// ai/src/services/context.builder.ts (three copies, kept in sync manually).
// Price starts at 0 (unset) since no real pricing existed anywhere in the
// codebase before this — a Super Admin fills in the real figures once via
// the Platform Defaults page.
export const DEFAULT_AI_PLAN_DEFAULTS: Record<PlanTier, IAiPlanDefaults> = {
  starter:      { monthlyTokenLimit: 300_000,   monthlyVoiceMinutesLimit: 100,  priceUsdPerMonth: 0 },
  growth:       { monthlyTokenLimit: 1_000_000, monthlyVoiceMinutesLimit: 250,  priceUsdPerMonth: 0 },
  professional: { monthlyTokenLimit: 1_500_000, monthlyVoiceMinutesLimit: 500,  priceUsdPerMonth: 0 },
  enterprise:   { monthlyTokenLimit: 8_000_000, monthlyVoiceMinutesLimit: 3000, priceUsdPerMonth: 0 },
};

const aiPlanDefaultsFieldSchema = {
  monthlyTokenLimit: Number,
  monthlyVoiceMinutesLimit: Number,
  priceUsdPerMonth: Number,
};

export interface IPlatformDefaults extends Document<string> {
  featureFlags: IFeatureFlags;
  aiPlanDefaults: Record<PlanTier, IAiPlanDefaults>;
}

const platformDefaultsSchema = new Schema<IPlatformDefaults>(
  {
    _id: { type: String, default: SINGLETON_ID },
    featureFlags: featureFlagsSchemaFields,
    aiPlanDefaults: {
      starter:      aiPlanDefaultsFieldSchema,
      growth:       aiPlanDefaultsFieldSchema,
      professional: aiPlanDefaultsFieldSchema,
      enterprise:   aiPlanDefaultsFieldSchema,
    },
  },
  { timestamps: true, _id: false }
);

export const PlatformDefaults = mongoose.model<IPlatformDefaults>('PlatformDefaults', platformDefaultsSchema);

/** Returns the current template, seeding it from DEFAULT_FEATURE_FLAGS on
 * first-ever call (no admin has edited it yet). Never throws — falls back
 * to DEFAULT_FEATURE_FLAGS directly if the singleton is somehow missing. */
export async function getPlatformDefaults(): Promise<IFeatureFlags> {
  const existing = await PlatformDefaults.findById(SINGLETON_ID).lean();
  if (existing) return { ...DEFAULT_FEATURE_FLAGS, ...existing.featureFlags };

  try {
    await PlatformDefaults.create({ _id: SINGLETON_ID, featureFlags: DEFAULT_FEATURE_FLAGS });
  } catch {
    // Lost a first-write race to another request — fine, just read what won below.
  }
  const seeded = await PlatformDefaults.findById(SINGLETON_ID).lean();
  return { ...DEFAULT_FEATURE_FLAGS, ...(seeded?.featureFlags ?? {}) };
}

/** Full-replace the template, same convention as PUT /tenants/:id/features
 * ($set with the whole flags object, not a per-key merge). Upserts so this
 * works identically whether or not getPlatformDefaults() has ever run. */
export async function setPlatformDefaults(flags: Record<string, boolean>): Promise<IFeatureFlags> {
  const updated = await PlatformDefaults.findByIdAndUpdate(
    SINGLETON_ID,
    { $set: { featureFlags: flags } },
    { new: true, upsert: true, runValidators: false }
  ).lean();
  return { ...DEFAULT_FEATURE_FLAGS, ...(updated?.featureFlags ?? {}) };
}

/** Same "upsert-on-read, seed from defaults" convention as
 * getPlatformDefaults() above, for the per-plan AI token/voice-minute/price
 * table — the single shared source every consumer (tenant.service.ts's
 * getAiUsage(), admin.routes.ts's GET /admin/ai-usage, and the AI service's
 * own context.builder.ts via the internal tenant-context endpoint) now reads
 * from, replacing what used to be three independently-hardcoded copies. */
export async function getAiPlanDefaults(): Promise<Record<PlanTier, IAiPlanDefaults>> {
  const existing = await PlatformDefaults.findById(SINGLETON_ID).lean();
  if (existing?.aiPlanDefaults) return { ...DEFAULT_AI_PLAN_DEFAULTS, ...existing.aiPlanDefaults };

  try {
    await PlatformDefaults.create({ _id: SINGLETON_ID, aiPlanDefaults: DEFAULT_AI_PLAN_DEFAULTS });
  } catch {
    // Lost a first-write race to another request — fine, just read what won below.
  }
  const seeded = await PlatformDefaults.findById(SINGLETON_ID).lean();
  return { ...DEFAULT_AI_PLAN_DEFAULTS, ...(seeded?.aiPlanDefaults ?? {}) };
}

export async function setAiPlanDefaults(plans: Record<PlanTier, IAiPlanDefaults>): Promise<Record<PlanTier, IAiPlanDefaults>> {
  const updated = await PlatformDefaults.findByIdAndUpdate(
    SINGLETON_ID,
    { $set: { aiPlanDefaults: plans } },
    { new: true, upsert: true, runValidators: false }
  ).lean();
  return { ...DEFAULT_AI_PLAN_DEFAULTS, ...(updated?.aiPlanDefaults ?? {}) };
}

/** Resolves one plan's effective token/voice-minute limits — the single
 * call every per-tenant usage lookup makes instead of duplicating its own
 * plan-tier default map (see this file's header comment on
 * DEFAULT_AI_PLAN_DEFAULTS for what this replaced). */
export async function getPlanLimits(plan: string): Promise<{ monthlyTokenLimit: number; monthlyVoiceMinutesLimit: number }> {
  const all = await getAiPlanDefaults();
  const tier = all[plan as PlanTier] ?? all.starter;
  return { monthlyTokenLimit: tier.monthlyTokenLimit, monthlyVoiceMinutesLimit: tier.monthlyVoiceMinutesLimit };
}
