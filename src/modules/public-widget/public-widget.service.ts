import { Tenant, ITenant } from '../tenants/tenant.model';

/** The only place a widgetKey is resolved to a tenant — every widget route
 * calls this fresh (no caching), same "resolve tenant from an opaque
 * per-tenant identifier in the request" shape automation-webhooks/webhooks
 * already established for their own public endpoints. `widget.enabled` and
 * `isActive` are both checked so a disabled widget or a deactivated tenant
 * behaves identically to a genuinely unknown key. */
export async function resolveTenantByWidgetKey(widgetKey: string | undefined): Promise<ITenant | null> {
  if (!widgetKey) return null;
  return Tenant.findOne({ 'widget.widgetKey': widgetKey, 'widget.enabled': true, isActive: true });
}

/** Exact hostname match only — no subdomain wildcarding in this pass
 * (simplicity/explicitness over cleverness, per the plan). */
export function isOriginAllowed(origin: string | null | undefined, allowedDomains: string[] | undefined): boolean {
  if (!origin || !allowedDomains?.length) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return allowedDomains.some((d) => d.toLowerCase() === hostname);
  } catch {
    return false;
  }
}
