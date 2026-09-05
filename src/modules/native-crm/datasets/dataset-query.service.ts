import mongoose from 'mongoose';
import axios from 'axios';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { Dataset } from './dataset.model';
import { DatasetRecord } from './dataset-record.model';
import { DatasetVersion } from './dataset-version.model';

export type FilterOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'between';
export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: string;
  value2?: string;
}
export type QueryIntent = 'exact' | 'filter' | 'semantic' | 'hybrid' | 'aggregation';
export interface QueryPlan {
  intent: QueryIntent;
  filters?: FilterCondition[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  aggregation?: { type: 'count' };
  semanticQuery?: string;
}

export interface DatasetQueryResult {
  recordId: string;
  data: Record<string, unknown>;
  datasetId: string;
  datasetName: string;
  /** Which Dataset version this record was actually read from — a re-upload
   * can change price/specs under the same datasetId+recordId, so a Lead's
   * recorded interest needs to say WHICH version the visitor actually saw. */
  datasetVersion: number;
  sourceLabel: string;
  rowNumber: number;
}

// Hardcoded server-side caps (plan decision #7) — never overridden by
// whatever the query plan (fast-path or LLM classifier) proposes.
const STRUCTURED_LIMIT = 20;
const SEMANTIC_LIMIT = 10;

const ROLE_FIELDS = new Set(['name', 'category', 'price', 'location', 'date', 'description', 'identifier']);

/** Same operator-to-Mongo-clause shape as automation-rule.service.ts's own
 * oneConditionToMongoFilter — a separate, small implementation (not a
 * cross-import) since DatasetRecord's addressing convention genuinely
 * differs (a role name maps to `normalized.<role>`, everything else maps
 * to `data.<normalizedName>`, whereas the automation engine's own
 * condition compiler addresses `data.`/`customFields.` on a totally
 * different set of modules). */
function conditionToMongoClause(cond: FilterCondition): Record<string, unknown> {
  const field = cond.field.toLowerCase();
  const path = ROLE_FIELDS.has(field) ? `normalized.${field}` : `data.${field}`;
  const num = (v: string) => (Number.isNaN(Number(v)) ? v : Number(v));
  switch (cond.operator) {
    case '=':  return { [path]: num(cond.value) };
    case '!=': return { [path]: { $ne: num(cond.value) } };
    case '>':  return { [path]: { $gt: num(cond.value) } };
    case '<':  return { [path]: { $lt: num(cond.value) } };
    case '>=': return { [path]: { $gte: num(cond.value) } };
    case '<=': return { [path]: { $lte: num(cond.value) } };
    case 'contains': return { [path]: { $regex: String(cond.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
    case 'between': return { [path]: { $gte: num(cond.value), $lte: num(cond.value2 ?? cond.value) } };
    default: return {};
  }
}

/** Hardening Gap 5 — a `field` string in a QueryPlan came from either the
 * deterministic fast path or the LLM classifier (ai/src/query-router/),
 * never from a source this executor should trust blindly. A role name
 * (price/location/etc.) is always safe — it's a fixed, small, hardcoded
 * vocabulary. Anything else must be a REAL, currently-known
 * `normalizedName` for THIS dataset's active version, checked here before
 * it's ever interpolated into a Mongo path — silently dropping an unknown
 * field is the correct behavior (matches this executor's existing posture
 * of never surfacing an internal-shape error to the model), not throwing. */
// Real, confirmed bug this closes: the LLM classifier isn't guaranteed to
// emit exactly-lowercase field names (e.g. produced "Category" instead of
// "category" for a real query, live-confirmed against a real dataset) —
// ROLE_FIELDS and every normalizedName are always lowercase by
// construction (dataset-schema.service.ts's normalizeName()), so a
// case-mismatched but semantically valid field was being silently DROPPED
// by this exact check, leaving planToMongoFilter() with zero clauses —
// which doesn't fail closed, it runs an EFFECTIVELY UNFILTERED query
// instead, returning arbitrary unrelated records as if they matched.
// Lowercasing here (matching conditionToMongoClause()'s own lowercasing)
// closes that gap — a real, known field now matches regardless of casing,
// and a genuinely unknown field still correctly drops instead of silently
// returning everything.
function isKnownField(field: string, validFields: Set<string>): boolean {
  const f = field.toLowerCase();
  return ROLE_FIELDS.has(f) || validFields.has(f);
}

function planToMongoFilter(filters: FilterCondition[] | undefined, validFields: Set<string>): Record<string, unknown> {
  if (!filters || filters.length === 0) return {};
  const clauses = filters.filter((f) => isKnownField(f.field, validFields)).map(conditionToMongoClause);
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function toResult(rec: any, datasetName: string): DatasetQueryResult {
  return {
    recordId: rec.recordId, data: rec.data, datasetId: String(rec.datasetId),
    datasetName, datasetVersion: rec.datasetVersion, sourceLabel: rec.sourceName, rowNumber: rec.rowNumber,
  };
}

/**
 * The ONLY place a QueryPlan is ever actually executed against real data —
 * `tenantId` and `datasetId` are REQUIRED, EXPLICIT parameters here, never
 * read from inside the `plan` object itself (which has no such fields at
 * all — see ai/src/query-router/types.ts's own comment on why). The
 * caller (the search-dataset AI tool, via an internal route) always
 * derives these from real auth/session context, never from the model's
 * own tool-call arguments or the query plan's own content — this is
 * plan decision #10's actual enforcement point, not just a stated intent.
 *
 * Also enforces `availableToChatbot` and resolves `activeVersion` itself
 * — a disabled or nonexistent dataset simply returns no results, exactly
 * as if it didn't exist, regardless of what datasetId was requested.
 */
export async function executeDatasetQuery(
  tenantId: string, datasetId: string, plan: QueryPlan,
): Promise<{ results: DatasetQueryResult[]; count?: number; datasetName: string; degraded?: boolean } | null> {
  const dataset = await Dataset.findOne({ _id: datasetId, tenantId, availableToChatbot: true }).lean();
  if (!dataset || !dataset.activeVersion) return null;

  const activeVersionDoc = await DatasetVersion.findOne(
    { tenantId, datasetId, version: dataset.activeVersion },
  ).select('columns').lean();
  const validFields = new Set((activeVersionDoc?.columns ?? []).map((c) => c.normalizedName));

  const tid = new mongoose.Types.ObjectId(tenantId);
  const did = new mongoose.Types.ObjectId(datasetId);
  const baseFilter = { tenantId: tid, datasetId: did, datasetVersion: dataset.activeVersion };

  if (plan.intent === 'aggregation' && plan.aggregation?.type === 'count') {
    const count = await DatasetRecord.countDocuments({ ...baseFilter, ...planToMongoFilter(plan.filters, validFields) });
    return { results: [], count, datasetName: dataset.name };
  }

  if (plan.intent === 'semantic' || plan.intent === 'hybrid') {
    const semanticQuery = plan.semanticQuery ?? '';
    let semanticRecordIds: string[] = [];
    // Real, confirmed live bug this closes: a semantic-search call that
    // genuinely THREW (Voyage rate-limited, AI service unreachable, etc.)
    // was silently treated identically to "the search ran and confirmed
    // zero matches" — semanticRecordIds just stayed [], producing an
    // honest-looking empty result for a dataset that may have plenty of
    // real matching records. response-confidence.ts then correctly (by ITS
    // own logic) downgrades an empty/no-data tool result to the
    // low-confidence handoff message — so a transient embedding-provider
    // hiccup was surfacing to a real visitor as "I don't have a confident
    // answer," even though 18 real products existed the whole time. This
    // flag lets the two failure modes be told apart and handled
    // differently below.
    let semanticSearchFailed = false;
    if (semanticQuery) {
      try {
        const res = await axios.post(
          `${config.app.aiServiceUrl}/api/knowledge/dataset-search`,
          { tenantId, datasetId, datasetVersion: dataset.activeVersion, query: semanticQuery, limit: SEMANTIC_LIMIT },
          { headers: { 'x-api-key': config.ai.internalApiKey }, timeout: 20000 },
        );
        semanticRecordIds = (res.data?.data?.results ?? []).map((r: any) => r.recordId);
      } catch (err) {
        logger.warn('Dataset semantic search call failed', { tenantId, datasetId, error: (err as Error).message });
        semanticSearchFailed = true;
      }
    }

    if (plan.intent === 'semantic') {
      if (semanticSearchFailed) {
        // Degrade to a plain, unranked listing from this dataset rather
        // than reporting zero results — not as precisely matched as a real
        // semantic search would give, but a visitor seeing SOME real,
        // honestly-labeled products beats a false "nothing found" leading
        // straight to a human handoff.
        const records = await DatasetRecord.find(baseFilter).limit(SEMANTIC_LIMIT).lean();
        return { results: records.map((r) => toResult(r, dataset.name)), datasetName: dataset.name, degraded: true };
      }
      const records = await DatasetRecord.find({ ...baseFilter, recordId: { $in: semanticRecordIds } }).limit(SEMANTIC_LIMIT).lean();
      // Preserve Qdrant's own relevance order — Mongo's $in doesn't.
      const byId = new Map(records.map((r) => [r.recordId, r]));
      const ordered = semanticRecordIds.map((id) => byId.get(id)).filter(Boolean);
      return { results: ordered.map((r) => toResult(r, dataset.name)), datasetName: dataset.name };
    }

    // hybrid — intersect the structured filter with the semantic candidate
    // set, UNLESS semantic search itself failed, in which case that
    // intersection would just be `recordId: {$in: []}` (matches nothing) —
    // fall back to the structured filter alone instead, same reasoning as
    // the pure-semantic branch above.
    const structuredFilter = semanticSearchFailed
      ? { ...baseFilter, ...planToMongoFilter(plan.filters, validFields) }
      : { ...baseFilter, ...planToMongoFilter(plan.filters, validFields), recordId: { $in: semanticRecordIds } };
    const records = await DatasetRecord.find(structuredFilter).limit(STRUCTURED_LIMIT).lean();
    return { results: records.map((r) => toResult(r, dataset.name)), datasetName: dataset.name, degraded: semanticSearchFailed };
  }

  // exact | filter
  let query = DatasetRecord.find({ ...baseFilter, ...planToMongoFilter(plan.filters, validFields) });
  if (plan.sort && isKnownField(plan.sort.field, validFields)) {
    const sortField = plan.sort.field.toLowerCase();
    const path = ROLE_FIELDS.has(sortField) ? `normalized.${sortField}` : `data.${sortField}`;
    query = query.sort({ [path]: plan.sort.direction === 'asc' ? 1 : -1 });
  }
  const records = await query.limit(STRUCTURED_LIMIT).lean();
  return { results: records.map((r) => toResult(r, dataset.name)), datasetName: dataset.name };
}

export async function getDatasetRecordById(tenantId: string, datasetId: string, recordId: string): Promise<DatasetQueryResult | null> {
  const dataset = await Dataset.findOne({ _id: datasetId, tenantId, availableToChatbot: true }).lean();
  if (!dataset || !dataset.activeVersion) return null;
  const rec = await DatasetRecord.findOne({ tenantId, datasetId, datasetVersion: dataset.activeVersion, recordId }).lean();
  if (!rec) return null;
  return toResult(rec, dataset.name);
}

/** Every dataset a tenant has enabled for the widget — the AI agent's
 * context needs this to know which datasetId(s) exist and what their
 * schema looks like, without ever seeing raw rows (mirrors how
 * search_products' tenant is resolved, just for the generic Dataset
 * system). Only returns datasets that are both enabled AND have reached a
 * real active version — a still-importing or disabled dataset is
 * invisible to the widget, matching executeDatasetQuery's own posture. */
export async function listChatbotDatasets(tenantId: string) {
  const datasets = await Dataset.find({ tenantId, availableToChatbot: true, activeVersion: { $exists: true } }).lean();
  return datasets.map((d) => ({ datasetId: String(d._id), name: d.name }));
}
