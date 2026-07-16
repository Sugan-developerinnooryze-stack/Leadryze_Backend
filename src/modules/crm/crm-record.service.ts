import mongoose from 'mongoose';
import { CRMRecord, ICRMRecord } from './crm-record.model';
import { writeLog } from '../logs/log.service';
import { indexCRMRecords, removeMeiliRecords, buildMeiliId } from '../../services/meilisearch.service';

export interface ModuleInfo {
  module: string;
  count: number;
}

/** Returns distinct modules grouped by channel, with record counts */
export async function getCRMModules(
  tenantId: string,
  channels?: string[]
): Promise<Record<string, ModuleInfo[]>> {
  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(tenantId) };
  if (channels && channels.length > 0) filter.channel = { $in: channels };

  const agg = await CRMRecord.aggregate([
    { $match: filter },
    { $group: { _id: { channel: '$channel', module: '$module' }, count: { $sum: 1 } } },
    { $sort: { '_id.channel': 1, '_id.module': 1 } },
  ]);

  const result: Record<string, ModuleInfo[]> = {};
  for (const item of agg) {
    const ch = item._id.channel as string;
    if (!result[ch]) result[ch] = [];
    result[ch].push({ module: item._id.module as string, count: item.count as number });
  }
  return result;
}

/**
 * Delete ALL CRM records for a specific channel (connector type).
 * Called when a connector is disconnected so orphaned records don't linger.
 * Also removes them from Meilisearch.
 */
export async function purgeChannelRecords(
  tenantId: string,
  channel: string
): Promise<number> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const records = await CRMRecord.find({ tenantId: tid, channel }).select('channel module externalId').lean();
  const meiliIds = records.map((r) => buildMeiliId(tenantId, r.channel, r.module, r.externalId));
  const { deletedCount } = await CRMRecord.deleteMany({ tenantId: tid, channel });
  if (meiliIds.length > 0) {
    await removeMeiliRecords(meiliIds).catch(() => {});
  }
  return deletedCount ?? 0;
}

/** Paginated records for a specific channel + module */
export async function getCRMRecords(
  tenantId: string,
  channel: string,
  module: string,
  page = 1,
  limit = 100,
  search?: string
) {
  const filter: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
    channel,
    module,
  };
  if (search) filter.displayName = { $regex: search, $options: 'i' };

  const [data, total] = await Promise.all([
    CRMRecord.find(filter)
      .sort({ displayName: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CRMRecord.countDocuments(filter),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export interface UpsertOptions {
  connectorName?: string;
  triggeredBy?: string;
}

/** Bulk upsert records for a module — insert new, update existing, log what changed */
export async function upsertCRMRecords(
  tenantId: string,
  channel: string,
  module: string,
  records: { externalId: string; displayName: string; data: Record<string, unknown> }[],
  options?: UpsertOptions
): Promise<number> {
  if (records.length === 0) return 0;
  const tid = new mongoose.Types.ObjectId(tenantId);

  // Fetch all existing records for this module in one query
  const existingRecords = await CRMRecord.find({
    tenantId: tid,
    channel,
    module,
    externalId: { $in: records.map((r) => r.externalId) },
  }).lean();

  const existingMap = new Map(existingRecords.map((r) => [r.externalId, r]));

  // Detect what actually changed
  const newEntries:     Array<{ externalId: string; displayName: string }> = [];
  const changedEntries: Array<{
    externalId: string;
    displayName: string;
    previousDisplayName?: string;
    changedFields: Array<{ field: string; from: unknown; to: unknown }>;
  }> = [];

  for (const record of records) {
    const existing = existingMap.get(record.externalId);
    if (!existing) {
      newEntries.push({ externalId: record.externalId, displayName: record.displayName });
      continue;
    }

    const changedFields: Array<{ field: string; from: unknown; to: unknown }> = [];

    // Check displayName change (visible name in UI)
    if (existing.displayName !== record.displayName) {
      changedFields.push({ field: 'Name', from: existing.displayName, to: record.displayName });
    }

    // Compare data fields — only flag keys that exist in both and actually changed
    const existingData = (existing.data as Record<string, unknown>) || {};
    for (const key of Object.keys(record.data)) {
      const oldVal = existingData[key];
      const newVal = record.data[key];
      // Skip null/undefined no-ops and large nested objects
      if (oldVal === undefined || newVal === undefined) continue;
      if (typeof newVal === 'object' && newVal !== null) continue;
      if (String(oldVal) !== String(newVal)) {
        changedFields.push({ field: key, from: oldVal, to: newVal });
      }
    }

    if (changedFields.length > 0) {
      changedEntries.push({
        externalId:          record.externalId,
        displayName:         record.displayName,
        previousDisplayName: existing.displayName !== record.displayName ? existing.displayName : undefined,
        changedFields,
      });
    }
  }

  // Perform the bulk upsert
  const ops = records.map((r) => ({
    updateOne: {
      filter: { tenantId: tid, channel, module, externalId: r.externalId },
      update: { $set: { displayName: r.displayName, data: r.data, syncedAt: new Date() } },
      upsert: true,
    },
  }));
  await CRMRecord.bulkWrite(ops);

  // Mirror to Meilisearch (fire-and-forget — non-critical)
  indexCRMRecords(records.map((r) => ({
    tenantId,
    channel,
    module,
    externalId: r.externalId,
    displayName: r.displayName,
    data: r.data,
  })));

  // Log new records (up to 20 to avoid flooding)
  if (newEntries.length > 0) {
    writeLog({
      tenantId,
      service:  'backend',
      level:    'info',
      event:    'crm.record.created',
      message:  `${newEntries.length} new ${module} record(s) added via ${channel}${options?.connectorName ? ` (${options.connectorName})` : ''}`,
      metadata: {
        channel,
        module,
        connectorName:  options?.connectorName,
        triggeredBy:    options?.triggeredBy ?? 'sync',
        count:          newEntries.length,
        records:        newEntries.slice(0, 20).map((r) => r.displayName),
      },
    });
  }

  // Log changed records — one entry per changed record so each is searchable
  for (const entry of changedEntries) {
    const nameChange = entry.previousDisplayName
      ? `"${entry.previousDisplayName}" → "${entry.displayName}"`
      : `"${entry.displayName}"`;

    writeLog({
      tenantId,
      service:  'backend',
      level:    'info',
      event:    'crm.record.updated',
      message:  `${module} record ${nameChange} updated via ${channel}${options?.connectorName ? ` (${options.connectorName})` : ''}`,
      metadata: {
        channel,
        module,
        connectorName:       options?.connectorName,
        triggeredBy:         options?.triggeredBy ?? 'sync',
        externalId:          entry.externalId,
        displayName:         entry.displayName,
        previousDisplayName: entry.previousDisplayName,
        changedFields:       entry.changedFields,
      },
    });
  }

  return ops.length;
}

/** Rename module keys in existing records — fixes stale API names (e.g. Events→Meetings).
 *  Called once per sync after the friendly-name mapping is applied going forward. */
export async function renameCRMModule(
  tenantId: string,
  channel: string,
  oldModule: string,
  newModule: string
): Promise<void> {
  if (oldModule === newModule) return;
  const tid = new mongoose.Types.ObjectId(tenantId);
  await CRMRecord.updateMany(
    { tenantId: tid, channel, module: oldModule },
    { $set: { module: newModule } }
  );
}

export async function getCRMRecordById(tenantId: string, id: string): Promise<ICRMRecord | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CRMRecord.findOne({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) }).lean() as any;
}

export async function updateCRMRecord(
  tenantId: string,
  id: string,
  changedData: Record<string, unknown>,
  displayName?: string,
): Promise<ICRMRecord | null> {
  const setFields: Record<string, unknown> = { syncedAt: new Date() };
  for (const [k, v] of Object.entries(changedData)) setFields[`data.${k}`] = v;
  if (displayName !== undefined && displayName !== '') setFields.displayName = displayName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CRMRecord.findOneAndUpdate(
    { _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) },
    { $set: setFields },
    { new: true },
  ).lean() as any;
}

export async function deleteCRMRecordLocal(tenantId: string, id: string): Promise<ICRMRecord | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CRMRecord.findOneAndDelete({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) }).lean() as any;
}

export async function createCRMRecordLocal(
  tenantId: string,
  channel: string,
  module: string,
  externalId: string,
  displayName: string,
  data: Record<string, unknown>,
): Promise<ICRMRecord> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CRMRecord.create({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    channel, module, externalId, displayName, data, syncedAt: new Date(),
  }) as any;
}

// ── Concept → related words (NOT module names — module names are fetched dynamically) ──
// Add words here when a new concept needs synonyms. Module names are never hardcoded.
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  task:        ['task', 'todo', 'work', 'job', 'action', 'item', 'activity', 'checklist'],
  meeting:     ['meeting', 'appointment', 'schedule', 'event', 'session', 'booking', 'slot'],
  call:        ['call', 'phone', 'dial', 'ring', 'conversation'],
  ticket:      ['ticket', 'case', 'issue', 'support', 'request', 'complaint', 'problem', 'incident'],
  deal:        ['deal', 'opportunity', 'pipeline', 'prospect', 'sale', 'potential', 'revenue'],
  contact:     ['contact', 'lead', 'prospect', 'customer', 'person', 'client', 'people', 'member'],
  invoice:     ['invoice', 'bill', 'receipt', 'billing', 'charge', 'payment', 'debit'],
  order:       ['order', 'purchase', 'buy', 'transaction', 'procurement'],
  note:        ['note', 'comment', 'remark', 'memo', 'annotation', 'feedback'],
  product:     ['product', 'item', 'sku', 'catalog', 'inventory', 'goods', 'service', 'listing'],
  account:     ['account', 'company', 'organisation', 'organization', 'firm', 'business', 'vendor', 'partner'],
  quote:       ['quote', 'proposal', 'estimate', 'tender', 'bid', 'offer'],
  campaign:    ['campaign', 'marketing', 'promotion', 'blast', 'newsletter', 'outreach'],
  project:     ['project', 'initiative', 'program', 'programme', 'epic', 'milestone'],
  reminder:    ['reminder', 'alert', 'followup', 'follow', 'notification', 'nudge'],
  segment:     ['segment', 'list', 'group', 'cohort', 'audience', 'filter'],
};

/**
 * Tokenise a module name into lowercase words.
 * Handles camelCase, PascalCase, snake_case, kebab-case, spaces.
 * e.g. "WorkOrders" → ["work","orders"], "support_tickets" → ["support","tickets"]
 */
function tokeniseModuleName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ABCDef → ABC Def
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 1);
}

/**
 * Expand user message words with synonyms.
 * Returns a Set of all original words + their concept synonyms.
 */
function expandMessageWords(message: string): Set<string> {
  const words = message.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const expanded = new Set<string>(words);
  for (const word of words) {
    for (const synonyms of Object.values(CONCEPT_SYNONYMS)) {
      if (synonyms.some((s) => s === word || s.startsWith(word) || word.startsWith(s))) {
        synonyms.forEach((s) => expanded.add(s));
      }
    }
  }
  return expanded;
}

/**
 * Score how well a module name matches the expanded query words.
 * Higher = better match.
 */
function scoreModule(moduleName: string, expandedWords: Set<string>): number {
  const tokens = tokeniseModuleName(moduleName);
  let score = 0;
  for (const token of tokens) {
    for (const word of expandedWords) {
      if (token === word)                          score += 10; // exact
      else if (token.startsWith(word) || word.startsWith(token)) score += 5;  // prefix
    }
  }
  return score;
}

/**
 * Produce a compact one-line summary for a CRM record.
 * Dynamically picks the top non-null fields — works for any schema.
 * Skips internal/system fields (long IDs, raw HTML, base64, etc.)
 */
function summariseRecord(
  displayName: string,
  channel: string,
  module: string,
  data: Record<string, unknown>,
): string {
  const fields = Object.entries(data)
    .filter(([, v]) => {
      if (v == null || v === '' || v === false) return false;
      const s = String(v);
      // Skip very long strings (HTML, base64, JSON blobs) and pure numeric IDs
      if (s.length > 120) return false;
      if (/^[a-f0-9]{20,}$/i.test(s)) return false;
      return true;
    })
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
  return `  - [${module}/${channel}] ${displayName}${fields ? ' | ' + fields : ''}`;
}

/**
 * Fetch CRM records from MongoDB relevant to a chat message.
 * Fully dynamic — discovers module names from the tenant's actual data,
 * scores them by word overlap with the question (no hardcoded module names).
 */
export async function getCRMContextForChat(
  tenantId: string,
  message: string,
): Promise<string> {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const lines: string[] = [];
  const now   = new Date();
  const lower = message.toLowerCase();

  // ── 0. Resolve active connector channels — never include disconnected data ─
  const { Connector } = await import('../connectors/connector.model');
  const activeConnectors = await Connector.find({ tenantId, isActive: true }).select('type').lean();
  const activeChannels = activeConnectors.map((c) => c.type as string);
  // Own-data channels that are always available
  const ALWAYS_INCLUDE = ['native', 'web'];
  const allowedChannels = [...new Set([...activeChannels, ...ALWAYS_INCLUDE])];

  // ── 1. Get all real module names this tenant has (active channels only) ────
  const moduleFilter: Record<string, unknown> = { tenantId: tid };
  if (activeChannels.length > 0) moduleFilter.channel = { $in: allowedChannels };
  const allModules: string[] = await CRMRecord.distinct('module', moduleFilter);

  // ── 2. Score each module against the user's message ───────────────────────
  const expandedWords = expandMessageWords(message);
  const scored = allModules
    .map((m) => ({ module: m, score: scoreModule(m, expandedWords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // ── 3. Use best-matching modules, fall back to all if nothing matched ──────
  const targetModules = scored.length > 0
    ? scored.slice(0, 4).map((x) => x.module)   // top 4 matches
    : allModules.slice(0, 3);                     // fallback: sample any 3 modules

  // ── 4. Fetch records from target modules (active channels only) ───────────
  if (targetModules.length > 0) {
    const recordFilter: Record<string, unknown> = {
      tenantId: tid,
      module:   { $in: targetModules },
    };
    if (activeChannels.length > 0) recordFilter.channel = { $in: allowedChannels };
    const records = await CRMRecord.find(recordFilter)
      .sort({ syncedAt: -1 })
      .limit(12)
      .lean();

    if (records.length > 0) {
      const moduleList = [...new Set(records.map((r) => r.module))].join(', ');
      lines.push(`${moduleList} records (${records.length} found):`);
      for (const r of records) {
        lines.push(summariseRecord(r.displayName, r.channel, r.module, (r.data as Record<string, unknown>) ?? {}));
      }
    }
  }

  // ── 5. Date range counts (no module filtering needed) ────────────────────
  if (/last month/.test(lower)) {
    const m     = now.getMonth();
    const y     = now.getFullYear();
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m, 0, 23, 59, 59);
    const count = await CRMRecord.countDocuments({ tenantId: tid, createdAt: { $gte: start, $lte: end } });
    lines.push(`Total CRM records added last month (${start.toLocaleDateString()} – ${end.toLocaleDateString()}): ${count}`);
  }
  if (/this month/.test(lower)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const count = await CRMRecord.countDocuments({ tenantId: tid, createdAt: { $gte: start } });
    lines.push(`Total CRM records added this month so far: ${count}`);
  }
  if (/this week/.test(lower)) {
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const count = await CRMRecord.countDocuments({ tenantId: tid, createdAt: { $gte: start } });
    lines.push(`Total CRM records added this week: ${count}`);
  }

  // ── 6. Prepend current date/time for any date-aware question ─────────────
  const hasDateIntent = /today|this week|this month|last month|pending|due|overdue|reminder|follow.?up|schedule|booking/.test(lower);
  if (hasDateIntent || targetModules.length > 0) {
    lines.unshift(
      `Current date/time: ${now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString('en-IN')}`,
    );
  }

  return lines.join('\n');
}

/** Remove records that no longer exist in the source (mirror delete) */
export async function deleteMissingCRMRecords(
  tenantId: string,
  channel: string,
  module: string,
  syncedExternalIds: string[]
): Promise<number> {
  if (syncedExternalIds.length === 0) return 0;
  const tid = new mongoose.Types.ObjectId(tenantId);

  // Find which externalIds are about to be deleted so we can clean Meilisearch
  const toDelete = await CRMRecord.find({
    tenantId: tid, channel, module,
    externalId: { $nin: syncedExternalIds },
  }).select('externalId').lean();

  const result = await CRMRecord.deleteMany({
    tenantId: tid, channel, module,
    externalId: { $nin: syncedExternalIds },
  });

  // Mirror delete to Meilisearch (fire-and-forget)
  if (toDelete.length > 0) {
    const meiliIds = toDelete.map((r) => buildMeiliId(tenantId, channel, module, r.externalId));
    removeMeiliRecords(meiliIds);
  }

  return result.deletedCount ?? 0;
}
