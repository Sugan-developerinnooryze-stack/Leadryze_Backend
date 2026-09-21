import crypto from 'crypto';
import { Tenant, ITenant } from './tenant.model';
import { parsePagination, buildSkip } from '../../utils/pagination';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../services/s3.service';
import { DEFAULT_DATA_SCOPE_CONFIG } from '../native-crm/shared/data-scope';
import { getTenantTokenUsageThisMonth, getTenantVoiceMinutesUsageThisMonth } from '../admin/ai-token-usage.model';

// Mirrors admin.routes.ts's GET /admin/ai-usage and ai/src/services/
// context.builder.ts's own default map for this same field — all three
// kept in sync manually (no shared-constants module exists yet in this
// codebase for cross-service config; matching the established pattern
// rather than introducing one here).
const DEFAULT_MONTHLY_TOKEN_LIMITS: Record<string, number> = {
  starter: 300_000, growth: 1_000_000, professional: 1_500_000, enterprise: 8_000_000,
};
const DEFAULT_MONTHLY_VOICE_MINUTES_LIMITS: Record<string, number> = {
  starter: 100, growth: 250, professional: 500, enterprise: 3000,
};

export type AiUsageStatus = 'normal' | 'warning' | 'critical' | 'exceeded';

/** Self-service version of admin.routes.ts's GET /admin/ai-usage, scoped to
 * ONE tenant (a Tenant Admin's own) instead of the SUPER_ADMIN-only
 * cross-tenant table — this is what the new AI Usage & Limits settings page
 * reads. `status` is admin-facing only (drives the UI's badge color); it
 * never changes visitor-facing widget behavior, which still only switches
 * at 100%/exceeded via checkTenantTokenQuota() (ai/src/core/guardrails/
 * rate-limiter.ts), unchanged by this endpoint. */
export async function getAiUsage(tenantId: string) {
  const tenant = await Tenant.findById(tenantId).select('plan aiConfig').lean();
  if (!tenant) return null;

  const planDefaultTokenLimit = DEFAULT_MONTHLY_TOKEN_LIMITS[tenant.plan] ?? DEFAULT_MONTHLY_TOKEN_LIMITS.starter;
  const planDefaultVoiceMinutesLimit = DEFAULT_MONTHLY_VOICE_MINUTES_LIMITS[tenant.plan] ?? DEFAULT_MONTHLY_VOICE_MINUTES_LIMITS.starter;
  const monthlyTokenLimit = tenant.aiConfig?.monthlyTokenLimit ?? planDefaultTokenLimit;
  const monthlyVoiceMinutesLimit = tenant.aiConfig?.monthlyVoiceMinutesLimit ?? planDefaultVoiceMinutesLimit;
  const warningThresholdPercent = tenant.aiConfig?.tokenWarningThresholdPercent ?? 80;
  const criticalThresholdPercent = tenant.aiConfig?.tokenCriticalThresholdPercent ?? 95;

  const [tokensUsedThisMonth, voiceMinutesUsedThisMonth] = await Promise.all([
    getTenantTokenUsageThisMonth(tenantId),
    getTenantVoiceMinutesUsageThisMonth(tenantId),
  ]);

  const percentUsed = monthlyTokenLimit > 0 ? (tokensUsedThisMonth / monthlyTokenLimit) * 100 : 0;
  const status: AiUsageStatus =
    percentUsed >= 100 ? 'exceeded' :
    percentUsed >= criticalThresholdPercent ? 'critical' :
    percentUsed >= warningThresholdPercent ? 'warning' : 'normal';

  return {
    plan: tenant.plan,
    planDefaultTokenLimit,
    customTokenLimit: tenant.aiConfig?.monthlyTokenLimit ?? null,
    monthlyTokenLimit, // the effective limit: custom override if set, else the plan default
    tokensUsedThisMonth,
    tokensRemaining: Math.max(0, monthlyTokenLimit - tokensUsedThisMonth),
    percentUsed: Math.round(percentUsed * 10) / 10,
    status,
    warningThresholdPercent,
    criticalThresholdPercent,
    monthlyVoiceMinutesLimit,
    voiceMinutesUsedThisMonth,
  };
}

export async function createTenant(data: Partial<ITenant>): Promise<ITenant> {
  if (!data.slug && data.name) {
    data.slug = data.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
  return Tenant.create(data);
}

export async function getTenants(query: Record<string, unknown>) {
  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = {};
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

  const [tenants, total] = await Promise.all([
    Tenant.find(filter)
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Tenant.countDocuments(filter),
  ]);
  return { tenants, total, page, limit };
}

export async function getTenantById(id: string): Promise<ITenant | null> {
  return Tenant.findById(id);
}

export async function updateTenant(
  id: string,
  data: Partial<ITenant>
): Promise<ITenant | null> {
  // `widget`, `aiConfig`, and `branding` are all handled separately, via
  // dot-notation, for the same correctness reason: a plain top-level
  // `$set: {widget:{...}}` (or `{aiConfig:{...}}`/`{branding:{...}}`) would
  // REPLACE the entire embedded subdocument, silently wiping out whichever
  // fields the caller's partial payload didn't happen to include (e.g.
  // saving just `allowedDomains` would erase `enabled`). `widget`
  // additionally has a security reason — widgetKey is server-generated only
  // (regenerateWidgetKey()), never accepted from this generic update
  // payload, no matter what a caller sends.
  //
  // This was a REAL, live bug for aiConfig specifically until this fix:
  // confirmed SettingsPage.tsx's own saveAI() already sends a partial
  // aiConfig ({agentName, language, systemPrompt} only) — every save from
  // that existing page was silently wiping fallbackToHuman/monthlyTokenLimit
  // back to their schema defaults before this dot-notation merge existed.
  // `branding` had the exact same bug: WidgetSettingsPage.tsx's own
  // handleContactInfoSave() sends only {contactEmail, contactPhone, address}
  // — a plain top-level replace would have wiped companyName/primaryColor/
  // logoUrl on every contact-info save.
  const { widget, aiConfig, branding, dataScopeConfig, ...rest } = data as Partial<ITenant> & {
    widget?: Record<string, unknown>;
    aiConfig?: Record<string, unknown>;
    branding?: Record<string, unknown>;
    dataScopeConfig?: Record<string, unknown>;
  };
  const update: Record<string, unknown> = { ...rest };
  if (widget && typeof widget === 'object') {
    for (const key of ['enabled', 'allowedDomains', 'greeting', 'quickQuestions', 'showBookingQuickReply', 'autoSendLeadEmails', 'defaultTeamId', 'websiteUrl', 'booking', 'template', 'voice']) {
      if (widget[key] !== undefined) update[`widget.${key}`] = widget[key];
    }
    // lastCrawledAt/crawlPageCount are deliberately NOT in the allow-list above —
    // they're status fields written only by recordWebsiteCrawlResult() below,
    // never accepted from the generic tenant-update payload.
  }
  if (branding && typeof branding === 'object') {
    // logoUrl deliberately NOT in this allow-list — same write-protection
    // precedent as widget.logoUrl/widgetKey above, server-uploaded only via
    // the dedicated logo endpoint.
    for (const key of ['companyName', 'primaryColor', 'contactEmail', 'contactPhone', 'address']) {
      if (branding[key] !== undefined) update[`branding.${key}`] = branding[key];
    }
  }
  if (aiConfig && typeof aiConfig === 'object') {
    for (const key of ['systemPrompt', 'language', 'fallbackToHuman', 'agentName', 'monthlyTokenLimit', 'monthlyVoiceMinutesLimit', 'tokenWarningThresholdPercent', 'tokenCriticalThresholdPercent', 'toolModelPreset', 'autoConvertLeadOnMeetingCompleted']) {
      if (aiConfig[key] !== undefined) update[`aiConfig.${key}`] = aiConfig[key];
    }
  }
  // Same "never wipe sibling keys" reasoning as widget/aiConfig above, but
  // the key set here is dynamic (one boolean per native-crm module) rather
  // than fixed — validated against DEFAULT_DATA_SCOPE_CONFIG's own keys
  // (the authoritative module list) instead of a hardcoded array, and each
  // value coerced to a real boolean so a stray non-boolean payload value
  // can never silently corrupt the toggle a module's own filter-builder
  // later reads as truthy/falsy.
  if (dataScopeConfig && typeof dataScopeConfig === 'object') {
    for (const key of Object.keys(DEFAULT_DATA_SCOPE_CONFIG)) {
      if (dataScopeConfig[key] !== undefined) update[`dataScopeConfig.${key}`] = Boolean(dataScopeConfig[key]);
    }
  }
  return Tenant.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
}

export async function deleteTenant(id: string): Promise<void> {
  await Tenant.findByIdAndUpdate(id, { isActive: false });
}

/** Server-generated only — never accepted as client input anywhere (see
 * updateTenant()'s own dot-notation write above, which deliberately never
 * includes widgetKey). Same crypto.randomBytes idiom as
 * automation-rule.service.ts's generateWebhookToken. Retries on the
 * astronomically unlikely event of a collision against the unique index. */
export async function regenerateWidgetKey(id: string): Promise<ITenant | null> {
  let widgetKey = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `wgt_${crypto.randomBytes(16).toString('hex')}`;
    const exists = await Tenant.exists({ 'widget.widgetKey': candidate });
    if (!exists) { widgetKey = candidate; break; }
  }
  if (!widgetKey) throw new Error('Failed to generate a unique widget key — try again');
  return Tenant.findByIdAndUpdate(id, { $set: { 'widget.widgetKey': widgetKey } }, { new: true });
}

/** Uploads a new widget logo to S3 and saves its URL — the only way
 * widget.logoUrl is ever set (see updateTenant()'s allow-list, which
 * deliberately excludes it, same protection as widgetKey). Best-effort
 * deletes the tenant's previous logo object from S3 so replacing a logo
 * doesn't silently accumulate orphaned files. */
export async function uploadWidgetLogo(
  id: string,
  file: { originalname: string; mimetype: string; buffer: Buffer }
): Promise<ITenant | null> {
  const existing = await Tenant.findById(id).select('widget.logoUrl').lean();
  const previousUrl = existing?.widget?.logoUrl;

  const url = await uploadToS3({
    tenantId: id,
    folder:   'widget-logo',
    filename: file.originalname,
    mimetype: file.mimetype,
    buffer:   file.buffer,
  });

  const tenant = await Tenant.findByIdAndUpdate(id, { $set: { 'widget.logoUrl': url } }, { new: true });

  if (previousUrl) {
    try { await deleteFromS3(keyFromUrl(previousUrl)); } catch { /* best-effort cleanup */ }
  }

  return tenant;
}

/** Clears the widget logo (falls back to the letter-avatar in the widget
 * UI). Best-effort deletes the S3 object. */
export async function removeWidgetLogo(id: string): Promise<ITenant | null> {
  const existing = await Tenant.findById(id).select('widget.logoUrl').lean();
  const previousUrl = existing?.widget?.logoUrl;

  const tenant = await Tenant.findByIdAndUpdate(id, { $unset: { 'widget.logoUrl': '' } }, { new: true });

  if (previousUrl) {
    try { await deleteFromS3(keyFromUrl(previousUrl)); } catch { /* best-effort cleanup */ }
  }

  return tenant;
}
