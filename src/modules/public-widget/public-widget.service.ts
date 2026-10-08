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

export interface ResolvedWidgetTheme {
  accentColor: string;
  headerColor: string;
  headerTextColor: string;
  backgroundColor: string;
  botBubbleColor: string;
  botTextColor: string;
  userBubbleColor: string;
  userTextColor: string;
  fontFamily: string;
  size: 'compact' | 'standard' | 'large';
  /** Tiled chat-body background image — undefined for every tenant who's
   * never uploaded one, in which case the widget just uses backgroundColor
   * alone, exactly as before this field existed. */
  backgroundImageUrl?: string;
}

export const WIDGET_FONT_STACK_DEFAULT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Every field a tenant could want to brand-match, always fully resolved —
 * an unset field falls back to the selected template's own default palette
 * (preserving today's exact look for any tenant who's never touched the new
 * theme settings), never to `undefined`, so the widget and the admin
 * settings preview never need their own separate fallback logic. The 'dark'
 * template is the one case whose defaults genuinely differ (near-black
 * header/dark user bubble instead of the accent color) — every other
 * template defaults to the tenant's own accent throughout, exactly matching
 * leadryze-widget's previous single-`primaryColor` behavior. */
export function resolveWidgetTheme(tenant: Pick<ITenant, 'branding' | 'widget'>): ResolvedWidgetTheme {
  const accentColor = tenant.widget?.theme?.accentColor || tenant.branding?.primaryColor || '#2563eb';
  const isDark = (tenant.widget?.template || 'modern') === 'dark';
  const t = tenant.widget?.theme ?? {};

  return {
    accentColor,
    headerColor:     t.headerColor     || (isDark ? '#1a1f2e' : accentColor),
    headerTextColor: t.headerTextColor || '#ffffff',
    backgroundColor: t.backgroundColor || (isDark ? '#f4f5f7' : '#f8f9fb'),
    botBubbleColor:  t.botBubbleColor  || '#ffffff',
    botTextColor:    t.botTextColor    || '#1e2430',
    userBubbleColor: t.userBubbleColor || (isDark ? '#1a1f2e' : accentColor),
    userTextColor:   t.userTextColor   || '#ffffff',
    fontFamily:      t.fontFamily      || WIDGET_FONT_STACK_DEFAULT,
    size:            t.size            || 'standard',
    backgroundImageUrl: t.backgroundImageUrl,
  };
}
