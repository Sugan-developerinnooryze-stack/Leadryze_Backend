import { MeiliSearch } from 'meilisearch';
import { logger } from '../utils/logger';

const INDEX_NAME = 'crm_records';
const SECONDARY_PATTERN = /note|task|call|log|history|activity|event|feed|inbox|audit|trail|macro|webform|campaign/i;

let _client: MeiliSearch | null = null;

function getClient(): MeiliSearch | null {
  const url = process.env.MEILISEARCH_URL;
  if (!url) return null;
  if (!_client) {
    _client = new MeiliSearch({
      host: url,
      apiKey: process.env.MEILISEARCH_API_KEY || '',
    });
  }
  return _client;
}

export function isMeiliSearchEnabled(): boolean {
  return !!process.env.MEILISEARCH_URL;
}

/** Stable compound ID so we never need an extra DB lookup */
export function buildMeiliId(
  tenantId: string, channel: string, module: string, externalId: string
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return `${safe(tenantId)}_${safe(channel)}_${safe(module)}_${safe(externalId)}`;
}

/** Called once at server startup — idempotent */
export async function ensureMeiliIndex(): Promise<void> {
  const client = getClient();
  if (!client) {
    logger.info('MeiliSearch not configured — universal search will use MongoDB fallback');
    return;
  }
  try {
    // createIndex is a no-op if the index exists
    await client.createIndex(INDEX_NAME, { primaryKey: 'id' }).catch(() => {});

    await client.index(INDEX_NAME).updateSettings({
      searchableAttributes: ['displayName', 'searchText'],
      filterableAttributes: ['tenantId', 'channel', 'module', 'isSecondary'],
      sortableAttributes: ['displayName', 'isSecondary'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
      },
    });

    logger.info('MeiliSearch index ready', { host: process.env.MEILISEARCH_URL });
  } catch (err) {
    logger.warn('MeiliSearch setup warning — search will fall back to MongoDB', {
      err: (err as Error).message,
    });
  }
}

export interface MeiliCRMRecord {
  id: string;
  tenantId: string;
  channel: string;
  module: string;
  displayName: string;
  isSecondary: boolean;
  data: Record<string, string>;
}

/**
 * Recursively extracts all leaf string/number values from any nested structure.
 * Handles: plain values, nested objects (e.g. Zoho Who_Id: {name, id}),
 * and arrays of strings or objects. Prevents infinite recursion at depth 5.
 */
function extractLeafValues(val: unknown, depth = 0): string[] {
  if (depth > 5 || val == null) return [];
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    const s = String(val).trim();
    return s.length > 0 && s !== 'null' && s !== 'undefined' ? [s] : [];
  }
  if (Array.isArray(val)) {
    return val.flatMap((item) => extractLeafValues(item, depth + 1));
  }
  if (typeof val === 'object') {
    return Object.values(val as Record<string, unknown>)
      .flatMap((v) => extractLeafValues(v, depth + 1));
  }
  return [];
}

/** Flatten an entire data object into a deduplicated searchable string */
function buildSearchText(displayName: string, data: Record<string, unknown>): string {
  const parts: string[] = [displayName];
  for (const v of Object.values(data)) {
    parts.push(...extractLeafValues(v));
  }
  const unique = [...new Set(parts.filter(Boolean))];
  return unique.join(' | ').slice(0, 4000);
}

/** Flatten data to flat string map — nested objects become their leaf values joined */
function flattenDataToStrings(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    const leaves = extractLeafValues(v);
    if (leaves.length > 0) out[k] = leaves.join(', ').slice(0, 500);
  }
  return out;
}

/** Index or re-index a batch of CRM records. Fire-and-forget safe. */
export async function indexCRMRecords(
  records: Array<{
    tenantId: string;
    channel: string;
    module: string;
    externalId: string;
    displayName: string;
    data: Record<string, unknown>;
  }>
): Promise<void> {
  const client = getClient();
  if (!client || records.length === 0) return;

  try {
    const docs = records.map((r) => ({
      id:          buildMeiliId(r.tenantId, r.channel, r.module, r.externalId),
      tenantId:    r.tenantId,
      channel:     r.channel,
      module:      r.module,
      displayName: r.displayName,
      isSecondary: SECONDARY_PATTERN.test(r.module),
      searchText:  buildSearchText(r.displayName, r.data),
      data:        flattenDataToStrings(r.data),
    }));

    await client.index(INDEX_NAME).addDocuments(docs);
  } catch (err) {
    logger.warn('MeiliSearch indexCRMRecords error', { err: (err as Error).message });
  }
}

/** Delete specific documents from MeiliSearch by their compound IDs */
export async function removeMeiliRecords(ids: string[]): Promise<void> {
  const client = getClient();
  if (!client || ids.length === 0) return;
  try {
    await client.index(INDEX_NAME).deleteDocuments(ids);
  } catch (err) {
    logger.warn('MeiliSearch delete error', { err: (err as Error).message });
  }
}

/** Search — returns null if MeiliSearch is not configured (caller should fall back to MongoDB).
 *  Pass activeChannels to restrict results to only connected connectors.
 *  Always includes 'native' and 'web' (own-data channels that are never deactivated). */
export async function searchMeili(
  tenantId: string,
  query: string,
  limit = 8,
  activeChannels?: string[]
): Promise<MeiliCRMRecord[] | null> {
  const client = getClient();
  if (!client) return null;

  const tid = tenantId.replace(/"/g, '');
  let filter = `tenantId = "${tid}"`;
  if (activeChannels && activeChannels.length > 0) {
    const always = ['native', 'web'];
    const allowed = [...new Set([...activeChannels, ...always])];
    const channelFilter = allowed.map((c) => `channel = "${c}"`).join(' OR ');
    filter = `${filter} AND (${channelFilter})`;
  }

  try {
    const res = await client.index(INDEX_NAME).search<MeiliCRMRecord>(
      query,
      {
        filter,
        limit,
        sort: ['isSecondary:asc'],
        attributesToRetrieve: ['id', 'tenantId', 'channel', 'module', 'displayName', 'isSecondary', 'data'],
      }
    );

    return res.hits.map((h: MeiliCRMRecord) => ({
      id: h.id,
      tenantId: h.tenantId,
      channel: h.channel,
      module: h.module,
      displayName: h.displayName,
      isSecondary: h.isSecondary ?? false,
      data: h.data ?? {},
    }));
  } catch (err) {
    logger.warn('MeiliSearch search error — falling back to MongoDB', { err: (err as Error).message });
    return null;
  }
}
