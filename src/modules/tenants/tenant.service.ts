import crypto from 'crypto';
import { Tenant, ITenant } from './tenant.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

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
  // `widget` is handled separately, via dot-notation, for two reasons: (1)
  // security — widgetKey is server-generated only (regenerateWidgetKey()),
  // never accepted from this generic update payload, no matter what a
  // caller sends; (2) correctness — a plain top-level `$set: {widget:{...}}`
  // would REPLACE the entire embedded subdocument, silently wiping out
  // whichever widget fields the caller's partial payload didn't happen to
  // include (e.g. saving just `allowedDomains` would erase `enabled`).
  const { widget, ...rest } = data as Partial<ITenant> & { widget?: Record<string, unknown> };
  const update: Record<string, unknown> = { ...rest };
  if (widget && typeof widget === 'object') {
    for (const key of ['enabled', 'allowedDomains', 'greeting', 'defaultTeamId', 'websiteUrl', 'booking']) {
      if (widget[key] !== undefined) update[`widget.${key}`] = widget[key];
    }
    // lastCrawledAt/crawlPageCount are deliberately NOT in the allow-list above —
    // they're status fields written only by recordWebsiteCrawlResult() below,
    // never accepted from the generic tenant-update payload.
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
