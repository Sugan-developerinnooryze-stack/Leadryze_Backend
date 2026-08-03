import mongoose from 'mongoose';
import crypto from 'crypto';
import { WebsiteProfile } from './website-profile.model';
import { KnowledgeSource } from './knowledge-source.model';

export interface WebsiteProfileFields {
  summary?: string;
  services?: string[];
  contact?: { phone?: string; email?: string; address?: string };
  hours?: string;
  staff?: Array<{ name: string; title?: string }>;
  faqs?: Array<{ question: string; answer: string }>;
  fieldSources: Record<string, 'jsonld' | 'llm'>;
}

const MAX_SERVICES = 10;
const MAX_STAFF = 15;
const MAX_FAQS = 15;

function computeContentHash(fields: WebsiteProfileFields): string {
  return crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

export async function getWebsiteProfile(tenantId: string) {
  return WebsiteProfile.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId) }).lean();
}

/**
 * The one write path for a tenant's WebsiteProfile — one document per
 * tenant, so unlike catalog items there's no sourceUrl/sku match key, just
 * tenantId itself. Skips the write entirely when the extracted fields are
 * unchanged since the last crawl (same content-hash convention as
 * upsertCatalogItemFromSource), and keeps the crawl's own KnowledgeSource
 * counters in sync rather than inventing a second tracking scheme.
 */
export async function upsertWebsiteProfileFromCrawl(
  tenantId: string,
  knowledgeSourceId: string,
  fields: WebsiteProfileFields
): Promise<{ outcome: 'created' | 'updated' | 'unchanged' | 'failed'; error?: string }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const ksId = new mongoose.Types.ObjectId(knowledgeSourceId);

  try {
    const capped: WebsiteProfileFields = {
      ...fields,
      services: fields.services?.slice(0, MAX_SERVICES),
      staff: fields.staff?.slice(0, MAX_STAFF),
      faqs: fields.faqs?.slice(0, MAX_FAQS),
    };
    const contentHash = computeContentHash(capped);

    const existing = await WebsiteProfile.findOne({ tenantId: tid });
    if (existing && existing.contentHash === contentHash) {
      return { outcome: 'unchanged' };
    }

    await WebsiteProfile.findOneAndUpdate(
      { tenantId: tid },
      { $set: { tenantId: tid, knowledgeSourceId: ksId, ...capped, contentHash, lastBuiltAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: existing ? { itemsUpdated: 1 } : { itemsImported: 1 } });
    return { outcome: existing ? 'updated' : 'created' };
  } catch (err) {
    await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: { itemsFailed: 1 }, $set: { lastError: (err as Error).message } });
    return { outcome: 'failed', error: (err as Error).message };
  }
}
