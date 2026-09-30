import mongoose, { Schema, Document } from 'mongoose';
import { IFeatureFlags, DEFAULT_FEATURE_FLAGS, featureFlagsSchemaFields } from '../tenants/tenant.model';

// Singleton — exactly one document, fixed _id so upsert always targets the
// same row. This is the Super-Admin-editable template new tenants inherit
// at creation time (see provisionTenant()/registerUser()), and what a
// tenant on accessConfigMode:'default' resolves its effective flags from.
const SINGLETON_ID = 'platform-defaults';

export interface IPlatformDefaults extends Document<string> {
  featureFlags: IFeatureFlags;
}

const platformDefaultsSchema = new Schema<IPlatformDefaults>(
  {
    _id: { type: String, default: SINGLETON_ID },
    featureFlags: featureFlagsSchemaFields,
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
