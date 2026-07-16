import mongoose from 'mongoose';

// A tenant's clientId never changes once assigned — safe to memoize for the
// process lifetime. Only real clientIds are cached (never the fallback), so a
// tenant that gets its clientId backfilled later is picked up on next lookup.
const prefixCache = new Map<string, string>();

/**
 * Resolves the human-readable clientId prefix for a tenant.
 * Falls back to the last 6 chars of the ObjectId if clientId is not yet set.
 */
export async function resolveClientPrefix(tenantId: mongoose.Types.ObjectId): Promise<string> {
  const key = tenantId.toString();
  const cached = prefixCache.get(key);
  if (cached) return cached;

  const tenant = await mongoose.model('Tenant')
    .findById(tenantId)
    .select('clientId')
    .lean() as { clientId?: string } | null;

  if (tenant?.clientId) {
    prefixCache.set(key, tenant.clientId);
    return tenant.clientId;
  }
  return key.slice(-6).toUpperCase();
}
