import crypto from 'crypto';
import { Tenant, ITenant } from './tenant.model';
import { parsePagination, buildSkip } from '../../utils/pagination';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../services/s3.service';
import { DEFAULT_DATA_SCOPE_CONFIG } from '../native-crm/shared/data-scope';

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
  // `widget` and `aiConfig` are both handled separately, via dot-notation,
  // for the same correctness reason: a plain top-level `$set: {widget:{...}}`
  // (or `{aiConfig:{...}}`) would REPLACE the entire embedded subdocument,
  // silently wiping out whichever fields the caller's partial payload didn't
  // happen to include (e.g. saving just `allowedDomains` would erase
  // `enabled`). `widget` additionally has a security reason — widgetKey is
  // server-generated only (regenerateWidgetKey()), never accepted from this
  // generic update payload, no matter what a caller sends.
  //
  // This was a REAL, live bug for aiConfig specifically until this fix:
  // confirmed SettingsPage.tsx's own saveAI() already sends a partial
  // aiConfig ({agentName, language, systemPrompt} only) — every save from
  // that existing page was silently wiping fallbackToHuman/monthlyTokenLimit
  // back to their schema defaults before this dot-notation merge existed.
  const { widget, aiConfig, dataScopeConfig, ...rest } = data as Partial<ITenant> & {
    widget?: Record<string, unknown>;
    aiConfig?: Record<string, unknown>;
    dataScopeConfig?: Record<string, unknown>;
  };
  const update: Record<string, unknown> = { ...rest };
  if (widget && typeof widget === 'object') {
    for (const key of ['enabled', 'allowedDomains', 'greeting', 'defaultTeamId', 'websiteUrl', 'booking', 'template', 'voice']) {
      if (widget[key] !== undefined) update[`widget.${key}`] = widget[key];
    }
    // lastCrawledAt/crawlPageCount are deliberately NOT in the allow-list above —
    // they're status fields written only by recordWebsiteCrawlResult() below,
    // never accepted from the generic tenant-update payload.
  }
  if (aiConfig && typeof aiConfig === 'object') {
    for (const key of ['systemPrompt', 'language', 'fallbackToHuman', 'agentName', 'monthlyTokenLimit', 'monthlyVoiceMinutesLimit', 'toolModelPreset', 'autoConvertLeadOnMeetingCompleted']) {
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
