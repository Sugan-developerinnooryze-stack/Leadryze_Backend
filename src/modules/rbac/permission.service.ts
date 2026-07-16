import { cacheGet, cacheSet, cacheDel, cacheDelPattern } from '../../config/redis';
import { RolePermission } from './role-permission.model';
import { IPermission } from './permission.model';

const CACHE_TTL = 300; // 5 minutes
const cacheKey  = (tenantId: string, roleId: string) => `perms:${tenantId}:${roleId}`;

/**
 * Returns the full set of permission keys assigned to a role.
 * Result is cached in Redis for 5 minutes.
 */
export async function getEffectivePermissions(tenantId: string, roleId: string): Promise<Set<string>> {
  const cached = await cacheGet(cacheKey(tenantId, roleId));
  if (cached) {
    return new Set<string>(JSON.parse(cached) as string[]);
  }

  const rolePerms = await RolePermission
    .find({ roleId, tenantId })
    .populate<{ permissionId: IPermission }>('permissionId', 'key');

  const keys = rolePerms
    .map((rp) => rp.permissionId?.key)
    .filter(Boolean) as string[];

  await cacheSet(cacheKey(tenantId, roleId), JSON.stringify(keys), CACHE_TTL);
  return new Set<string>(keys);
}

/**
 * Checks whether a role has a specific permission key.
 * Supports wildcard fallback: connector.zoho.accounts.view → connector.zoho.* → connector.*
 */
export async function hasPermission(tenantId: string, roleId: string, required: string): Promise<boolean> {
  const perms = await getEffectivePermissions(tenantId, roleId);

  if (perms.has(required)) return true;

  // Wildcard fallback — progressively shorter prefixes
  const parts = required.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    if (perms.has(parts.slice(0, i).join('.') + '.*')) return true;
  }

  return false;
}

/**
 * Returns all permission keys for a role as an array (used in login response).
 */
export async function getPermissionArray(tenantId: string, roleId: string): Promise<string[]> {
  const perms = await getEffectivePermissions(tenantId, roleId);
  return [...perms];
}

/**
 * Invalidate cached permissions for one role, or all roles in a tenant.
 */
export async function invalidateRoleCache(tenantId: string, roleId?: string): Promise<void> {
  if (roleId) {
    await cacheDel(cacheKey(tenantId, roleId));
  } else {
    await cacheDelPattern(`perms:${tenantId}:*`);
  }
}
