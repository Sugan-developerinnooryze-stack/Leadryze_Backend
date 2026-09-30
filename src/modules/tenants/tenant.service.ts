import crypto from 'crypto';
import { Tenant, ITenant, IFeatureFlags, DEFAULT_FEATURE_FLAGS } from './tenant.model';
import { parsePagination, buildSkip } from '../../utils/pagination';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../services/s3.service';
import { DEFAULT_DATA_SCOPE_CONFIG } from '../native-crm/shared/data-scope';
import { getTenantTokenUsageThisMonth, getTenantVoiceMinutesUsageThisMonth } from '../admin/ai-token-usage.model';
import { config } from '../../config';
import { User } from '../auth/auth.model';
import { Role } from '../rbac/role.model';
import { ensureSystemPermissions } from '../rbac/rbac.seed';
import { generatePassword } from '../native-crm/shared/app-credentials.service';
import { sendEmailNow, buildTenantCredentialsEmail } from '../messages/brevo.service';
import { logger } from '../../utils/logger';
import { encrypt } from '../../utils/crypto';

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

/** Shared, nullish-safe feature-flag read — matches the `!== false` (default
 * true) convention already used throughout the frontend (Sidebar.tsx,
 * CustomersPage.tsx) so a flag that's never been explicitly saved behaves
 * identically everywhere it's read, backend or frontend. */
export function isFeatureFlagEnabled(tenant: { featureFlags?: IFeatureFlags }, key: keyof IFeatureFlags): boolean {
  return tenant.featureFlags?.[key] !== false;
}

/** Resolves which flags actually apply to this tenant right now: the
 * Platform Defaults template when accessConfigMode is 'default' (a tenant
 * that's deliberately inheriting the current template, not a frozen copy
 * of it), or the tenant's own independently-stored featureFlags otherwise
 * — 'custom', or unset, which is what every pre-existing tenant already is.
 * Callers that only care about one key should still go through here (not
 * read tenant.featureFlags directly) so 'default' mode is honored
 * everywhere, not just in the Controls UI. */
export async function getEffectiveFeatureFlags(tenant: { featureFlags?: IFeatureFlags; accessConfigMode?: 'default' | 'custom' }): Promise<IFeatureFlags> {
  // Anything other than an explicit 'custom' opt-out reads live from
  // Platform Defaults — including tenants created before accessConfigMode
  // existed, whose stored value is undefined, not the literal string
  // 'default'. A strict `=== 'default'` check here silently left those
  // legacy tenants frozen on whatever featureFlags snapshot they happened
  // to have, never picking up Super Admin changes to Platform Defaults.
  if (tenant.accessConfigMode !== 'custom') {
    const { getPlatformDefaults } = await import('../admin/platform-defaults.model');
    return getPlatformDefaults();
  }
  return { ...DEFAULT_FEATURE_FLAGS, ...(tenant.featureFlags ?? {}) };
}

/** Batch version for a cron sweep that spans many tenants in one run
 * (runDailyFollowupCheck/runMeetingReminders/runCallMeetingReminders) — one
 * query for every distinct tenant touched this run instead of one query per
 * customer/activity/record, then a plain in-memory lookup inside the loop. */
export async function getFeatureFlagsForTenants(tenantIds: string[]): Promise<Map<string, IFeatureFlags | undefined>> {
  const uniqueIds = [...new Set(tenantIds)];
  if (uniqueIds.length === 0) return new Map();
  const tenants = await Tenant.find({ _id: { $in: uniqueIds } }).select('featureFlags').lean();
  const byId = new Map<string, IFeatureFlags | undefined>();
  for (const t of tenants) byId.set(String(t._id), t.featureFlags);
  return byId;
}

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

export interface ProvisionTenantInput {
  name: string;
  plan?: ITenant['plan'];
  domain?: string;
  contactEmail?: string;
  contactPhone?: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
}

export interface ProvisionTenantResult {
  tenant: ITenant;
  adminUser: Record<string, unknown>;
  clientId: string;
  loginId: string;
  temporaryPassword: string;
  emailSent: boolean;
}

/** Super Admin "Create Tenant" — creates a Tenant + its first TENANT_ADMIN
 * User together, auto-approved (no signup-approval gate; the Super Admin
 * creating it directly IS the approval). Mirrors registerUser()'s
 * Tenant+User creation shape (auth.service.ts) so both provisioning paths
 * produce an identically-usable tenant. The plaintext password is only
 * ever returned here — never persisted, never returned by any other
 * endpoint afterward. */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    + '-' + crypto.randomBytes(3).toString('hex');

  // Same generator/uniqueness-retry as self-signup (auth.service.ts:53-59)
  let clientId: string;
  let tries = 0;
  do {
    clientId = crypto.randomBytes(4).toString('hex').toUpperCase();
    tries++;
  } while (tries < 10 && await Tenant.exists({ clientId }));

  const { getPlatformDefaults } = await import('../admin/platform-defaults.model');
  const platformDefaults = await getPlatformDefaults();

  const tenant = await Tenant.create({
    clientId,
    name: input.name,
    slug,
    plan: input.plan ?? 'starter',
    domain: input.domain,
    isActive: true,
    approvalStatus: 'approved',
    // New tenant inherits whatever the Super-Admin-editable template
    // currently says, and stays on 'default' so future template edits keep
    // applying — switching to 'custom' later freezes its flags as of that
    // moment (see getEffectiveFeatureFlags()).
    accessConfigMode: 'default',
    featureFlags: platformDefaults,
    settings: {
      allowedChannels: ['web', 'whatsapp', 'email', 'sms'],
      maxUsers: 5,
      // The TENANT_ADMIN created right below already occupies one seat.
      currentUserCount: 1,
      maxLeadsPerMonth: 500,
      timezone: 'Asia/Kuala_Lumpur',
      language: 'en',
      crmOption: 'no_crm',
    },
    branding: {
      companyName: input.name,
      ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
      ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
    },
    aiConfig: {
      agentName: 'LeadBot',
      language: 'en',
      fallbackToHuman: true,
      systemPrompt: `You are LeadBot, an AI assistant for ${input.name}. Help capture leads and answer questions.`,
    },
  });

  const temporaryPassword = generatePassword();

  const user = await User.create({
    email: input.adminEmail.toLowerCase(),
    password: temporaryPassword, // hashed by the model's pre-save hook, never written raw
    // Encrypted (reversible) copy so the Super Admin panel can show/copy
    // the current password — only ever set for Super-Admin-issued
    // credentials, cleared the moment the user changes it themselves.
    passwordEnc: encrypt(temporaryPassword),
    firstName: input.adminFirstName,
    lastName: input.adminLastName,
    role: 'TENANT_ADMIN',
    tenantId: tenant._id,
    clientId,
    isActive: true,
    emailVerified: true, // no verification step in this path — the Super Admin creating it is the vetting step
    mustChangePassword: true,
  });

  // Fire-and-forget RBAC seeding — identical to registerUser()'s.
  ensureSystemPermissions(tenant._id.toString()).then(async () => {
    const adminRole = await Role.findOne({ tenantId: tenant._id, name: 'Admin' }, '_id').lean();
    if (adminRole) {
      await User.findByIdAndUpdate(user._id, { roleId: adminRole._id });
    }
  }).catch(() => {});

  let emailSent = true;
  try {
    const email = buildTenantCredentialsEmail({
      toName: input.adminFirstName,
      accountEmail: user.email,
      loginId: user.loginId ?? clientId,
      password: temporaryPassword,
      frontendUrl: config.app.frontendUrl,
    });
    await sendEmailNow({ ...email, to: user.email, toName: `${input.adminFirstName} ${input.adminLastName}` });
  } catch (err) {
    emailSent = false;
    logger.error('Tenant credentials email failed to send', { tenantId: tenant._id.toString(), email: user.email, error: (err as Error).message });
  }

  const userObj = user.toObject() as unknown as Record<string, unknown>;
  delete userObj.password;
  delete userObj.refreshToken;
  delete userObj.passwordEnc;

  return { tenant, adminUser: userObj, clientId, loginId: user.loginId ?? clientId, temporaryPassword, emailSent };
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
  const { widget, aiConfig, branding, dataScopeConfig, settings, ...rest } = data as Partial<ITenant> & {
    widget?: Record<string, unknown>;
    aiConfig?: Record<string, unknown>;
    branding?: Record<string, unknown>;
    dataScopeConfig?: Record<string, unknown>;
    settings?: Record<string, unknown>;
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
  // Same "never wipe sibling keys" reasoning as widget/aiConfig/branding
  // above — SettingsPage.tsx's saveTimezone() already sends a partial
  // {settings:{timezone}} payload, which without this allow-list would
  // `$set` the whole `settings` subdocument and silently erase
  // allowedChannels/maxLeadsPerMonth/crmOption/etc. back to absent.
  // `maxUsers`/`currentUserCount` are deliberately excluded — this route is
  // reachable by TENANT_ADMIN (PUT /tenants/:id), and the seat limit must
  // only be settable through the Super-Admin-only
  // PUT /admin/tenants/:id/features, or a tenant could raise its own cap.
  // `automationsPaused` is likewise excluded — it already has its own
  // dedicated endpoint, per the schema comment on that field.
  if (settings && typeof settings === 'object') {
    for (const key of ['allowedChannels', 'maxLeadsPerMonth', 'timezone', 'language', 'crmOption']) {
      if (settings[key] !== undefined) update[`settings.${key}`] = settings[key];
    }
  }
  return Tenant.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
}

export async function deleteTenant(id: string): Promise<void> {
  await Tenant.findByIdAndUpdate(id, { isActive: false });
}

/** Atomically reserves one seat against a tenant's settings.maxUsers cap
 * before a new active user (invite or reactivation) is created/applied.
 * This is a single-document conditional update, not a count-then-create —
 * this deployment's MongoDB connection is a standalone instance (no replica
 * set), so multi-document transactions aren't available to guard a separate
 * read+write against a race between two simultaneous requests. A
 * findOneAndUpdate's filter+update pair is evaluated atomically by MongoDB
 * itself, so two concurrent callers racing on the same Tenant document can
 * never both win the last seat — the standard "reserve one of N slots"
 * pattern. Returns true if a seat was reserved (caller may proceed), false
 * if the tenant is already at its cap (caller must reject with 403) or the
 * tenant doesn't exist. Missing/null maxUsers means unlimited. */
export async function reserveUserSeat(tenantId: string): Promise<boolean> {
  const reserved = await Tenant.findOneAndUpdate(
    {
      _id: tenantId,
      $or: [
        { 'settings.maxUsers': { $in: [null, undefined] } },
        { $expr: { $lt: [{ $ifNull: ['$settings.currentUserCount', 0] }, '$settings.maxUsers'] } },
      ],
    },
    { $inc: { 'settings.currentUserCount': 1 } },
  );
  return !!reserved;
}

/** Unconditional +1 — used when Super Admin adds a user directly (bypasses
 * the block in reserveUserSeat, but the seat must still count toward future
 * capacity so a later self-service invite doesn't silently slip past the
 * real limit). Never rejects. */
export async function forceAddUserSeat(tenantId: string): Promise<void> {
  await Tenant.updateOne({ _id: tenantId }, { $inc: { 'settings.currentUserCount': 1 } });
}

/** Frees a seat on deactivation, or compensates a reserveUserSeat() call
 * when the subsequent User.create()/save() fails for an unrelated reason —
 * unconditional, since releasing a seat can never race unsafely (unlike
 * reserving the last one). Floored at 0 so an already-drifted/undercounted
 * tenant can't be pushed negative by a double-release. */
export async function releaseUserSeat(tenantId: string): Promise<void> {
  await Tenant.updateOne(
    { _id: tenantId, 'settings.currentUserCount': { $gt: 0 } },
    { $inc: { 'settings.currentUserCount': -1 } },
  );
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
