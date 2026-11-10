import type { ModuleCap } from './registry/types';
import { usableModuleCaps } from './registry';
import { CRM_WRITE_MODULE_MAP } from '../internal/crm-write.module-map';
import { isModuleFlagDisabled } from '../internal/crm-gateway.helpers';
import { GateIdentity, GatewayTenant, identityHasPermission } from './gates';
import { logger } from '../../utils/logger';

/* The caller's capability view: which registry modules they may use right
 * now (module flag on and view permission held), in registry order. Built
 * per caller and cached for 60 s, keyed by tenant, user, role, roleId and
 * branch. It only narrows: every read still runs the gates (gates.ts) for
 * the module it touches, so a permission removed within the 60 s is still
 * refused there. */

export type ModuleAccess = 'ok' | 'disabled' | 'no_permission';

export interface CapabilityView {
  /** Usable modules the caller may read, in registry order. */
  readonly modules: readonly ModuleCap[];
  /** Why each registry module is or isn't available (registry modules only). */
  accessOf(module: string): ModuleAccess | 'unknown';
  has(module: string): boolean;
}

export const CAPABILITY_VIEW_TTL_MS = 60_000;
const MAX_CACHED_VIEWS = 5000;

const cache = new Map<string, { expiresAt: number; view: Promise<CapabilityView> }>();

export function capabilityViewKey(tenantId: string, identity: GateIdentity): string {
  return [tenantId, identity.userId ?? '-', identity.role ?? '-', identity.roleId ?? '-', identity.branchId ?? 'all'].join('|');
}

/** A registry entry is used only when it names the same module map entry
 * the gateway routes gate with (flag, permission prefix, scope key); a
 * mismatch is left out (fail closed) and logged. */
function agreesWithModuleMap(cap: ModuleCap): boolean {
  const def = CRM_WRITE_MODULE_MAP[cap.key];
  const ok = !!def && def.flagKey === cap.gate.flagKey && def.permissionPrefix === cap.gate.permPrefix
    && def.logModule === cap.gate.scopeKey;
  if (!ok) logger.error('CRM assistant: registry gate differs from the module map; module left out', { module: cap.key });
  return ok;
}

async function buildView(tenantId: string, identity: GateIdentity, tenant: GatewayTenant): Promise<CapabilityView> {
  const access = new Map<string, ModuleAccess>();
  const caps = usableModuleCaps().filter(agreesWithModuleMap);
  await Promise.all(caps.map(async (cap) => {
    if (isModuleFlagDisabled(tenant.flags, cap.gate.flagKey, identity.role)) { access.set(cap.key, 'disabled'); return; }
    const allowed = await identityHasPermission(tenantId, identity, `${cap.gate.permPrefix}.view`);
    access.set(cap.key, allowed ? 'ok' : 'no_permission');
  }));
  const modules = caps.filter((cap) => access.get(cap.key) === 'ok');
  return {
    modules,
    accessOf: (module) => access.get(module) ?? 'unknown',
    has: (module) => access.get(module) === 'ok',
  };
}

export function getCapabilityView(
  tenantId: string, identity: GateIdentity, tenant: GatewayTenant, now: number = Date.now(),
): Promise<CapabilityView> {
  const key = capabilityViewKey(tenantId, identity);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.view;
  if (cache.size >= MAX_CACHED_VIEWS) {
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
    if (cache.size >= MAX_CACHED_VIEWS) cache.delete(cache.keys().next().value as string);
  }
  const view = buildView(tenantId, identity, tenant);
  cache.set(key, { expiresAt: now + CAPABILITY_VIEW_TTL_MS, view });
  // A failed build is never served from the cache.
  view.catch(() => { if (cache.get(key)?.view === view) cache.delete(key); });
  return view;
}

/** For tests and for an admin change that must apply at once. */
export function clearCapabilityViewCache(): void {
  cache.clear();
}
