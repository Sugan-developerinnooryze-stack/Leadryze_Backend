import mongoose from 'mongoose';
import crypto from 'crypto';
import { CatalogItem } from './catalog-item.model';
import { KnowledgeSource } from './knowledge-source.model';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

/** Normalizes a specification/attribute key so the same real-world field
 * ("Pressure Rating", "pressure rating", "PressureRating") always collapses
 * to the same key ("pressure_rating") regardless of which source or import
 * batch it came from — consistent querying without a fixed cross-tenant
 * schema (every tenant's product fields are genuinely different). */
export function normalizeSpecKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeSpecMap(input?: Record<string, unknown>): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === '') continue;
    out[normalizeSpecKey(k)] = String(v);
  }
  return out;
}

function computeContentHash(fields: Record<string, unknown>): string {
  return crypto.createHash('sha1').update(JSON.stringify(fields)).digest('hex');
}

export async function listCatalogItems(tenantId: string, opts: any, branchId?: string | null) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const page = Number(opts.page ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  if (opts.category) filter.category = opts.category;
  if (opts.search) filter.$text = { $search: opts.search };
  const [items, total] = await Promise.all([
    CatalogItem.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    CatalogItem.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getCatalogItemById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return CatalogItem.findOne({ _id: id, tenantId: tid });
}

export async function getCatalogItemBySku(tenantId: string, sku: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return CatalogItem.findOne({ tenantId: tid, sku });
}

export async function searchCatalogItems(
  tenantId: string,
  opts: { query?: string; category?: string; limit?: number }
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { tenantId: tid };
  if (opts.category) filter.category = new RegExp(opts.category, 'i');
  if (opts.query) filter.$text = { $search: opts.query };
  return CatalogItem.find(filter)
    .select('title sku category subCategory shortDescription')
    .limit(opts.limit ?? 5);
}

export async function createCatalogItem(data: any) {
  const specifications = normalizeSpecMap(data.specifications);
  const attributes = normalizeSpecMap(data.attributes);
  const contentHash = computeContentHash({ ...data, specifications, attributes });
  const created = await CatalogItem.create({ ...data, specifications, attributes, contentHash });
  // Grouped under module:'products' (not 'catalog') — no dedicated Catalog
  // page exists in the frontend today; catalog items surface in search
  // alongside NativeProduct results, routing to the same /native-crm/products page.
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'products', created.toObject(), (created as any).title);
  return created;
}

export async function updateCatalogItem(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const update: any = { ...data };
  if (data.specifications) update.specifications = normalizeSpecMap(data.specifications);
  if (data.attributes) update.attributes = normalizeSpecMap(data.attributes);
  update.contentHash = computeContentHash(update);
  const updated = await CatalogItem.findOneAndUpdate({ _id: id, tenantId: tid }, update, { new: true, runValidators: true });
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'products', updated.toObject(), (updated as any).title);
  return updated;
}

export async function deleteCatalogItem(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const deleted = await CatalogItem.findOneAndDelete({ _id: id, tenantId: tid });
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'products', String(deleted._id));
  return deleted;
}

export interface UpsertCatalogFields {
  title: string;
  sku?: string;
  productCode?: string;
  category?: string;
  subCategory?: string;
  shortDescription?: string;
  longDescription?: string;
  specifications?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  pdfs?: string[];
  images?: string[];
  videos?: string[];
  tags?: string[];
}

/**
 * The one shared convergence point every source (website crawl today; a
 * future PDF/MySQL/Postgres source later) calls to write a catalog item —
 * normalizes spec/attribute keys, computes a contentHash and skips the write
 * entirely when unchanged, and keeps the owning KnowledgeSource's counters
 * in sync. `matchKey` is whichever of sourceUrl/sku identifies this item
 * for idempotent re-sync (a crawl matches on sourceUrl; an import matches on
 * sku when present, otherwise it's always a new item).
 */
export async function upsertCatalogItemFromSource(
  tenantId: string,
  knowledgeSourceId: string,
  source: 'crawl' | 'import',
  matchKey: { sourceUrl?: string; sku?: string },
  fields: UpsertCatalogFields
): Promise<{ outcome: 'created' | 'updated' | 'unchanged' | 'failed'; error?: string }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const ksId = new mongoose.Types.ObjectId(knowledgeSourceId);

  try {
    if (!fields.title || !fields.title.trim()) {
      await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: { itemsFailed: 1 } });
      return { outcome: 'failed', error: 'Missing title' };
    }

    const specifications = normalizeSpecMap(fields.specifications);
    const attributes = normalizeSpecMap(fields.attributes);
    const contentHash = computeContentHash({ ...fields, specifications, attributes });

    const query: any = { tenantId: tid };
    if (matchKey.sourceUrl) query.sourceUrl = matchKey.sourceUrl;
    else if (matchKey.sku) query.sku = matchKey.sku;
    else {
      // No stable match key at all — always a new item (e.g. an import row with no sku).
      const created = await CatalogItem.create({
        tenantId: tid, source, knowledgeSourceId: ksId,
        ...fields, specifications, attributes, contentHash,
      });
      indexNativeSearchRecord(tenantId, 'native-crm', 'products', created.toObject(), fields.title);
      await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: { itemsImported: 1 } });
      return { outcome: 'created' };
    }

    const existing = await CatalogItem.findOne(query);
    if (existing && existing.contentHash === contentHash) {
      return { outcome: 'unchanged' };
    }

    const upserted = await CatalogItem.findOneAndUpdate(
      query,
      { $set: { tenantId: tid, source, knowledgeSourceId: ksId, ...fields, specifications, attributes, contentHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (upserted) indexNativeSearchRecord(tenantId, 'native-crm', 'products', upserted.toObject(), fields.title);
    await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: existing ? { itemsUpdated: 1 } : { itemsImported: 1 } });
    return { outcome: existing ? 'updated' : 'created' };
  } catch (err) {
    await KnowledgeSource.findByIdAndUpdate(ksId, { $inc: { itemsFailed: 1 }, $set: { lastError: (err as Error).message } });
    return { outcome: 'failed', error: (err as Error).message };
  }
}

/** Finds-or-creates the persistent KnowledgeSource identity for one distinct
 * source (a website URL, an uploaded filename) and marks it 'running' —
 * re-syncing the same source updates this same doc rather than creating a
 * new row per run. */
export async function startKnowledgeSourceSync(
  tenantId: string,
  type: 'website' | 'excel' | 'csv' | 'json',
  label: string
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return KnowledgeSource.findOneAndUpdate(
    { tenantId: tid, type, label },
    { $set: { status: 'running' }, $setOnInsert: { itemsImported: 0, itemsUpdated: 0, itemsFailed: 0 } },
    { upsert: true, new: true }
  );
}

export async function finishKnowledgeSourceSync(
  knowledgeSourceId: string,
  outcome: 'completed' | 'failed',
  durationMs: number,
  error?: string
) {
  await KnowledgeSource.findByIdAndUpdate(knowledgeSourceId, {
    $set: { status: outcome, lastSyncAt: new Date(), lastSyncDurationMs: durationMs, lastError: error },
  });
}

export interface ImportRowResult { row: number; outcome: string; error?: string }
export interface ImportSummary {
  knowledgeSourceId: string;
  total: number; created: number; updated: number; unchanged: number; rejected: ImportRowResult[];
}

// Column-name aliases recognized as well-known catalog fields; every other
// column in a row is preserved under `specifications` (key-normalized) —
// nothing is dropped just because the header isn't one of these.
const KNOWN_ALIASES: Record<string, keyof UpsertCatalogFields> = {
  title: 'title', name: 'title', productname: 'title',
  sku: 'sku', code: 'sku',
  productcode: 'productCode',
  category: 'category',
  subcategory: 'subCategory',
  description: 'shortDescription', shortdescription: 'shortDescription',
  longdescription: 'longDescription', details: 'longDescription',
};

function splitRowFields(row: Record<string, unknown>): UpsertCatalogFields {
  const fields: UpsertCatalogFields = { title: '' };
  const specifications: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(row)) {
    if (value === undefined || value === null || value === '') continue;
    const aliasKey = normalizeSpecKey(rawKey);
    const known = KNOWN_ALIASES[aliasKey];
    if (known) (fields as any)[known] = String(value);
    else specifications[rawKey] = value;
  }
  fields.specifications = specifications;
  return fields;
}

/** Bulk import — parsing already happened client-side (Excel/CSV/JSON all
 * arrive here as plain JSON rows, same convention as the existing Lead
 * import feature). Each row is upserted via the same shared
 * upsertCatalogItemFromSource() the crawler also uses. */
export async function importCatalogRows(
  tenantId: string,
  fileType: 'excel' | 'csv' | 'json',
  fileLabel: string,
  rows: Array<Record<string, unknown>>
): Promise<ImportSummary> {
  const startedAt = Date.now();
  const source = await startKnowledgeSourceSync(tenantId, fileType, fileLabel);
  const knowledgeSourceId = String(source._id);

  const rejected: ImportRowResult[] = [];
  let created = 0, updated = 0, unchanged = 0;

  for (let i = 0; i < rows.length; i++) {
    const fields = splitRowFields(rows[i]);
    const result = await upsertCatalogItemFromSource(
      tenantId, knowledgeSourceId, 'import',
      { sku: fields.sku }, fields
    );
    if (result.outcome === 'created') created++;
    else if (result.outcome === 'updated') updated++;
    else if (result.outcome === 'unchanged') unchanged++;
    else rejected.push({ row: i + 1, outcome: 'failed', error: result.error });
  }

  await finishKnowledgeSourceSync(
    knowledgeSourceId,
    rejected.length === rows.length && rows.length > 0 ? 'failed' : 'completed',
    Date.now() - startedAt
  );

  return { knowledgeSourceId, total: rows.length, created, updated, unchanged, rejected };
}
