import mongoose from 'mongoose';
import { Connector } from '../../connectors/connector.model';
import { CRMRecord } from '../../crm/crm-record.model';

/* The count-only connector registry (Increment 3; plan 3.6 and 4.8): which
 * synced CRMRecord module holds a vendor's deals or customers, and the reads
 * the assistant's connector counts need — the active connectors with their
 * sync state, the stored module names, a bounded key sample for fingerprints,
 * one count aggregation and an existence check. Every Connector and CRMRecord
 * read of the assistant lives here: no file under query/ imports a model.
 *
 * Stored module names are not stable. Salesforce stores a module under the
 * org's renamable plural label (connector.service.ts:1249), Zoho under
 * module_name, which has no spaces ("SalesOrders"), or its API name
 * ("Sales_Orders") (connector.service.ts:934). So a concept resolves by the
 * stored names first (equality with the vendor's default names, ignoring
 * case, spaces, underscores and hyphens), then by a key fingerprint over a
 * 50-record projection of each stored module (at most 30 modules); anything
 * else, and several equally good matches, is unresolved, never guessed. A
 * user can always name a stored module directly. Every spec is inferred from the vendor
 * documentation and the sync code until it is checked against a real tenant.
 *
 * Reads only. Connector Leads and Contacts live in the legacy Customer
 * collection, which is never read here (D11); CRMRecord never holds them. */

export type ConnectorType = 'zoho' | 'salesforce' | 'hubspot';
export type ConnectorConcept = 'deal' | 'customer';

export const CONNECTOR_TYPES: readonly ConnectorType[] = Object.freeze(['zoho', 'salesforce', 'hubspot'] as const);

/** The same names as Daily Events (daily-events.connectors.ts CONNECTOR_LABELS). */
export const CONNECTOR_TYPE_LABELS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  zoho: 'Zoho CRM',
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
});

export interface ConnectorModuleSpec {
  /** The vendor's usual name for the module, shown when no stored module is resolved. */
  label: string;
  /** Stored names it goes by unless renamed, preferred in this order. */
  defaultNames: string[];
  /** CRMRecord.data keys that identify it: every `all` key appears in the sample and no `none` key does. */
  fingerprint: { all: string[]; none?: string[] };
  /** Not yet checked against a real tenant's synced data. */
  inferred: true;
}

function spec(label: string, defaultNames: string[], all: string[], none?: string[]): ConnectorModuleSpec {
  return Object.freeze({
    label,
    defaultNames: Object.freeze([...defaultNames]) as string[],
    fingerprint: Object.freeze({ all: Object.freeze([...all]) as string[], ...(none ? { none: Object.freeze([...none]) as string[] } : {}) }),
    inferred: true as const,
  });
}

/* Data keys as each sync stores them: Zoho under its field labels with "_"
 * for spaces (Deal_Name, Account_Name; connector.service.ts:945-953, and
 * Potentials are stored as Deals, :899-902), Salesforce under API names
 * (StageName, CloseDate; :1243-1247), HubSpot under property names, non-empty
 * values only (dealname, dealstage; :1428-1430). The deal keys are the ones
 * Daily Events reads (daily-events.connectors.ts:42-88). Salesforce Quotes,
 * Orders and Contracts also store Name and the billing address fields, so a
 * Salesforce customer module must lack OpportunityId (a Quote's) and
 * AccountId (an Order's or Contract's), which an Account never has; both
 * come early in those objects' describe, inside the 40 fields the sync keeps
 * (:1225-1227). */
export const CONNECTOR_CONCEPT_MODULES: Readonly<Record<ConnectorType, Readonly<Record<ConnectorConcept, ConnectorModuleSpec>>>> = Object.freeze({
  zoho: Object.freeze({
    deal: spec('Deals', ['Deals', 'Potentials'], ['Deal_Name', 'Stage']),
    customer: spec('Accounts', ['Accounts'], ['Account_Name'], ['Deal_Name']),
  }),
  salesforce: Object.freeze({
    deal: spec('Opportunities', ['Opportunities'], ['StageName', 'CloseDate']),
    customer: spec('Accounts', ['Accounts'], ['Name', 'BillingCity'], ['StageName', 'OpportunityId', 'AccountId']),
  }),
  hubspot: Object.freeze({
    deal: spec('Deals', ['Deals'], ['dealname', 'dealstage']),
    customer: spec('Companies', ['Companies'], ['name', 'domain'], ['dealname']),
  }),
});

/** Rows a sync keeps per module at most: Salesforce queries LIMIT 5000 and
 * deletes every row it did not fetch (connector.service.ts:1234,1252);
 * HubSpot reads at most 10,000 rows per object (:1420). Zoho has no cap. A
 * count at the cap is a lower bound. */
export const CONNECTOR_VENDOR_ROW_CAPS: Readonly<Partial<Record<ConnectorType, number>>> = Object.freeze({
  salesforce: 5000,
  hubspot: 10000,
});

/** maxTimeMS of every read here. 3 s, not the plan's 5 s: the AI service gives a
 * whole resolve call 4 s (ai/src/agents/crm-assist/engine.ts) before it falls
 * back to the existing assistant. */
export const CONNECTOR_QUERY_TIME_MS = 3000;
/** How long a tenant's resolutions (and its stored module list) are reused, per connector type. */
export const CONNECTOR_RESOLUTION_TTL_MS = 60_000;
/** Records sampled per stored module for a fingerprint. */
export const FINGERPRINT_SAMPLE_SIZE = 50;
/** Stored modules fingerprinted at most per resolution (in name order). */
export const MAX_FINGERPRINT_MODULES = 30;
const FINGERPRINT_PARALLEL = 6;
const MAX_CACHED_RESOLUTIONS = 2000;

export function isConnectorType(value: unknown): value is ConnectorType {
  return typeof value === 'string' && (CONNECTOR_TYPES as readonly string[]).includes(value);
}

/** connector.<type>.<stored module lower-cased>.view: the key the sync creates
 * for each module (connector.service.ts:1859-1862) and the CRM data routes
 * require (crm-record.routes.ts:20-27). Wildcards (connector.<type>.*,
 * connector.*) are honoured by the permission service. */
export function connectorModuleViewKey(type: ConnectorType, module: string): string {
  return `connector.${type}.${module.toLowerCase()}.view`;
}

function tenantObjectId(tenantId: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(tenantId);
}

function dateOf(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/* ── Active connectors and their sync state ────────────────────────────── */

export type ConnectorSyncStatus = 'idle' | 'syncing' | 'success' | 'failed' | 'unknown';

export interface ConnectorSyncState {
  /** Active connectors of this type (nothing makes one per type unique). */
  connectors: number;
  /** The least healthy state across them: failed, then syncing, then idle, then success. */
  syncStatus: ConnectorSyncStatus;
  /** The latest lastSyncAt across them; null when none has one. */
  lastSyncAt: Date | null;
}

const SYNC_RANK: Readonly<Record<ConnectorSyncStatus, number>> = { failed: 3, syncing: 2, idle: 1, unknown: 1, success: 0 };

function syncStatusOf(value: unknown): ConnectorSyncStatus {
  // A document without the field has the schema default.
  if (value === null || value === undefined) return 'idle';
  return value === 'idle' || value === 'syncing' || value === 'success' || value === 'failed' ? value : 'unknown';
}

/** The active connectors of the given types, one entry per type that has at
 * least one: CRMRecord rows are keyed by connector type, so connectors of one
 * type share one state (Daily Events' rule, daily-events.service.ts:375-388). */
export async function activeConnectorSync(
  tenantId: string, types: readonly ConnectorType[] = CONNECTOR_TYPES,
): Promise<Map<ConnectorType, ConnectorSyncState>> {
  const wanted = types.filter(isConnectorType);
  const out = new Map<ConnectorType, ConnectorSyncState>();
  if (!wanted.length) return out;
  const rows = (await Connector.find({ tenantId: tenantObjectId(tenantId), isActive: true, type: { $in: [...wanted] } })
    .select('type syncStatus lastSyncAt')
    .lean()
    .maxTimeMS(CONNECTOR_QUERY_TIME_MS)) as unknown as Array<{ type?: unknown; syncStatus?: unknown; lastSyncAt?: unknown }>;
  for (const row of rows ?? []) {
    const type = row?.type;
    if (!isConnectorType(type) || !wanted.includes(type)) continue;
    const status = syncStatusOf(row.syncStatus);
    const last = dateOf(row.lastSyncAt);
    const prev = out.get(type);
    if (!prev) { out.set(type, { connectors: 1, syncStatus: status, lastSyncAt: last }); continue; }
    prev.connectors += 1;
    if (SYNC_RANK[status] > SYNC_RANK[prev.syncStatus]) prev.syncStatus = status;
    if (last && (!prev.lastSyncAt || last > prev.lastSyncAt)) prev.lastSyncAt = last;
  }
  return out;
}

/* ── Counting ──────────────────────────────────────────────────────────── */

export interface ConnectorModuleCount {
  count: number;
  /** The module's latest CRMRecord.syncedAt. Screen edits also set it (crm-record.service.ts:247,274). */
  moduleSyncedAt: Date | null;
}

/** One aggregation over { tenantId, channel, module } (the CRMRecord index):
 * the row count and the latest syncedAt, as the internal /sync-status route
 * computes them (internal.routes.ts:1733-1737), limited to 5 s. Rejects when
 * the count isn't a number, so a failure is never shown as 0. */
export async function countConnectorRecords(tenantId: string, type: ConnectorType, module: string): Promise<ConnectorModuleCount> {
  const rows = await CRMRecord.aggregate<{ count?: unknown; lastSynced?: unknown }>([
    { $match: { tenantId: tenantObjectId(tenantId), channel: type, module } },
    { $group: { _id: null, count: { $sum: 1 }, lastSynced: { $max: '$syncedAt' } } },
  ]).option({ maxTimeMS: CONNECTOR_QUERY_TIME_MS });
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { count: 0, moduleSyncedAt: null };
  const count = row.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error('The connector count is not a number');
  return { count, moduleSyncedAt: dateOf(row.lastSynced) };
}

/** True when the module holds at least one synced row (an indexed existence check). */
export async function connectorModuleHasRows(tenantId: string, type: ConnectorType, module: string): Promise<boolean> {
  const hit = await CRMRecord.exists({ tenantId: tenantObjectId(tenantId), channel: type, module }).maxTimeMS(CONNECTOR_QUERY_TIME_MS);
  return !!hit;
}

/* ── Stored modules and resolution ─────────────────────────────────────── */

export type ConnectorModuleResolution =
  | { status: 'resolved'; module: string; via: 'name' | 'fingerprint' | 'stored' }
  /** ambiguous: several stored modules matched equally well, so none was chosen (never a guess). */
  | { status: 'unresolved'; storedModules: string[]; ambiguous?: true };

export type ConnectorModuleRequest = { concept: ConnectorConcept } | { storedModule: string };

interface ResolutionEntry {
  expiresAt: number;
  stored: Promise<string[]> | null;
  resolutions: Map<string, Promise<ConnectorModuleResolution>>;
}

const resolutionCache = new Map<string, ResolutionEntry>();

/** Whitespace folded and trimmed, for comparing and showing module names. */
export function normaliseModuleName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** For matching only: case, spaces, underscores and hyphens ignored, so
 * "sales orders" meets Zoho's "SalesOrders" and "Sales_Orders". */
function foldName(name: string): string {
  return normaliseModuleName(name).toLowerCase().replace(/[\s_-]+/g, '');
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

function entryFor(tenantId: string, type: ConnectorType, now: number): ResolutionEntry {
  const key = `${tenantId}|${type}`;
  const hit = resolutionCache.get(key);
  if (hit && hit.expiresAt > now) return hit;
  if (hit) resolutionCache.delete(key);
  if (resolutionCache.size >= MAX_CACHED_RESOLUTIONS) {
    for (const [k, entry] of resolutionCache) if (entry.expiresAt <= now) resolutionCache.delete(k);
    if (resolutionCache.size >= MAX_CACHED_RESOLUTIONS) resolutionCache.delete(resolutionCache.keys().next().value as string);
  }
  const entry: ResolutionEntry = { expiresAt: now + CONNECTOR_RESOLUTION_TTL_MS, stored: null, resolutions: new Map() };
  resolutionCache.set(key, entry);
  return entry;
}

async function readStoredModules(tenantId: string, type: ConnectorType): Promise<string[]> {
  const values = await CRMRecord.distinct('module', { tenantId: tenantObjectId(tenantId), channel: type }).maxTimeMS(CONNECTOR_QUERY_TIME_MS);
  const names = (Array.isArray(values) ? values : []).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return Object.freeze(Array.from(new Set(names)).sort(byName)) as string[];
}

/** A failed read is never served from the cache. */
function storedModulesOf(entry: ResolutionEntry, tenantId: string, type: ConnectorType): Promise<string[]> {
  if (!entry.stored) {
    const pending = readStoredModules(tenantId, type);
    entry.stored = pending;
    pending.catch(() => { if (entry.stored === pending) entry.stored = null; });
  }
  return entry.stored;
}

/** The module names stored for this connector type, in name order (cached with the resolutions). */
export async function storedConnectorModules(tenantId: string, type: ConnectorType): Promise<string[]> {
  if (!isConnectorType(type)) throw new Error(`Unknown connector type "${String(type)}"`);
  return [...await storedModulesOf(entryFor(tenantId, type, Date.now()), tenantId, type)];
}

/** The stored module for the first of `names` (in order) that any stored
 * module matches, ignoring case, spaces, underscores and hyphens: the one
 * spelled exactly as asked, else the only match. Several matches and none
 * spelled exactly as asked are ambiguous (never a guess); null when no
 * stored module matches any name. */
function pickByName(stored: readonly string[], names: readonly string[]): { module: string } | { ambiguous: true } | null {
  for (const name of names) {
    const wanted = foldName(name);
    if (!wanted) continue;
    const hits = stored.filter((s) => foldName(s) === wanted);
    if (!hits.length) continue;
    if (hits.includes(name)) return { module: name };
    return hits.length === 1 ? { module: hits[0] } : { ambiguous: true };
  }
  return null;
}

/** True when every `all` key appears in at least one sampled record (a
 * HubSpot record stores only non-empty properties) and no `none` key appears
 * in any. A key stored with a null value still counts: the vendor sent it. */
export function fingerprintFits(
  fingerprint: ConnectorModuleSpec['fingerprint'], sample: ReadonlyArray<Record<string, unknown>>,
): boolean {
  if (!sample.length || !fingerprint.all.length) return false;
  const seen = (key: string) => sample.some((data) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined);
  return fingerprint.all.every(seen) && !(fingerprint.none ?? []).some(seen);
}

/** The data keys of up to 50 records of one stored module, projected to the
 * fingerprint's keys only (no other record value is read). */
async function sampleModuleData(
  tenantId: string, type: ConnectorType, module: string, projection: Record<string, 0 | 1>,
): Promise<Array<Record<string, unknown>>> {
  const rows = (await CRMRecord.find({ tenantId: tenantObjectId(tenantId), channel: type, module })
    .select(projection)
    .limit(FINGERPRINT_SAMPLE_SIZE)
    .lean()
    .maxTimeMS(CONNECTOR_QUERY_TIME_MS)) as unknown as Array<{ data?: unknown }>;
  return (rows ?? []).map((row) => {
    const data = row?.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  });
}

/** The stored modules (the first 30 in name order, six read at a time) whose sample fits the fingerprint. */
async function fingerprintMatches(
  tenantId: string, type: ConnectorType, moduleSpec: ConnectorModuleSpec, stored: readonly string[],
): Promise<string[]> {
  const candidates = stored.slice(0, MAX_FINGERPRINT_MODULES);
  const projection: Record<string, 0 | 1> = { _id: 0 };
  for (const key of [...moduleSpec.fingerprint.all, ...(moduleSpec.fingerprint.none ?? [])]) projection[`data.${key}`] = 1;
  const matched: string[] = [];
  for (let i = 0; i < candidates.length; i += FINGERPRINT_PARALLEL) {
    const batch = candidates.slice(i, i + FINGERPRINT_PARALLEL);
    const samples = await Promise.all(batch.map((module) => sampleModuleData(tenantId, type, module, projection)));
    batch.forEach((module, j) => { if (fingerprintFits(moduleSpec.fingerprint, samples[j])) matched.push(module); });
  }
  return matched;
}

function requestKey(request: ConnectorModuleRequest): string {
  if ('concept' in request) {
    if (request.concept !== 'deal' && request.concept !== 'customer') throw new Error(`Unknown connector concept "${String(request.concept)}"`);
    return `concept:${request.concept}`;
  }
  if (typeof request.storedModule !== 'string') throw new Error('A stored module name is required');
  // Not folded: the exact spelling can pick one of several modules that fold alike.
  return `stored:${normaliseModuleName(request.storedModule)}`;
}

async function resolveUncached(
  tenantId: string, type: ConnectorType, request: ConnectorModuleRequest, entry: ResolutionEntry,
): Promise<ConnectorModuleResolution> {
  const stored = await storedModulesOf(entry, tenantId, type);
  const unresolved = (ambiguous: boolean): ConnectorModuleResolution => Object.freeze({
    status: 'unresolved' as const, storedModules: Object.freeze([...stored]) as string[], ...(ambiguous ? { ambiguous: true as const } : {}),
  });
  if ('storedModule' in request) {
    const picked = pickByName(stored, [normaliseModuleName(request.storedModule)]);
    if (picked && 'module' in picked) return Object.freeze({ status: 'resolved' as const, module: picked.module, via: 'stored' as const });
    return unresolved(picked !== null);
  }
  const moduleSpec = CONNECTOR_CONCEPT_MODULES[type][request.concept];
  const named = pickByName(stored, moduleSpec.defaultNames);
  if (named && 'module' in named) return Object.freeze({ status: 'resolved' as const, module: named.module, via: 'name' as const });
  // A default name stored more than once (in ways that fold alike) is not fingerprinted into a guess.
  if (named) return unresolved(true);
  // Exactly one fitting module resolves; none or several stay unresolved (never a guess).
  const matched = await fingerprintMatches(tenantId, type, moduleSpec, stored);
  return matched.length === 1 ? Object.freeze({ status: 'resolved' as const, module: matched[0], via: 'fingerprint' as const }) : unresolved(matched.length > 1);
}

/** resolveConnectorModule with the clock given (the cache is checked at `now`, epoch ms). */
export function resolveConnectorModuleAt(
  tenantId: string, type: ConnectorType, request: ConnectorModuleRequest, now: number,
): Promise<ConnectorModuleResolution> {
  try {
    if (!isConnectorType(type)) throw new Error(`Unknown connector type "${String(type)}"`);
    const key = requestKey(request);
    const entry = entryFor(tenantId, type, now);
    const hit = entry.resolutions.get(key);
    if (hit) return hit;
    const pending = resolveUncached(tenantId, type, request, entry);
    entry.resolutions.set(key, pending);
    // A failed resolution is never served from the cache.
    pending.catch(() => { if (entry.resolutions.get(key) === pending) entry.resolutions.delete(key); });
    return pending;
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Stored names first (equality with defaultNames, or with the asked stored module, ignoring case, spaces, underscores
 * and hyphens; an exact spelling wins, and several matches without one are unresolved), then the
 * fingerprint over a 50-record projection of each candidate (bounded: at most 30 modules); cached 60 s per tenant+type. */
export async function resolveConnectorModule(
  tenantId: string, type: ConnectorType, request: { concept: ConnectorConcept } | { storedModule: string },
): Promise<ConnectorModuleResolution> {
  return resolveConnectorModuleAt(tenantId, type, request, Date.now());
}

/** For tests, and for a sync that must show at once. */
export function clearConnectorResolutionCache(): void {
  resolutionCache.clear();
}
