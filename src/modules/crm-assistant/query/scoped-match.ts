import mongoose from 'mongoose';
import type { ModuleCap } from '../registry/types';
import { queryCapsFor } from '../registry/query-caps';
import { contactOwnerValues } from '../../native-crm/contacts/contact.service';
import { resolveOwnStaffId } from '../../native-crm/shared/data-scope';
import { FSSettings } from '../../native-crm/fs-settings/fs-settings.model';
import type { ExecContext } from './execute-list';

/* The only file under crm-assistant/query that touches a Mongoose model
 * (tests/crm-assist-scoped-match.test.ts guards this). Every executor Q read
 * starts here, with one filter shape (plan 4.3):
 *
 *   { $and: [ { tenantId, branchId? }, scopeObject, ...conditions ] }
 *
 * scopeObject is exactly what the module's scope closure (registry/query-caps.ts)
 * returns: the DataScope helper its own list() runs, applied to an empty object.
 * It is placed in the $and untouched and nothing is ever assigned into it, so a
 * condition, search or sort can only narrow it: the shared helpers write the
 * scope onto the filtered field itself or into $or, and merging anything into
 * that object could replace or widen it. A non-"all" scope that builds an empty
 * object fails closed (ScopeFailClosedError) instead of reading every record.
 * Every query carries maxTimeMS QUERY_MAX_TIME_MS (3000): the AI service gives
 * a whole resolve call 4000 ms before it falls back to the LLM. Reads also
 * follow the module's own list() (QueryCaps): its collation on every find,
 * count and breakdown (leads and contacts sort and match case-insensitively),
 * the references it populates on every find, and the step it runs on its rows
 * after the read (QueryCaps.afterRead: the contact and company names listDeals
 * fills in, read by deal.service's own lookups by id, which carry no maxTimeMS,
 * exactly as on executor L).
 *
 * Increment 5 reads through the same filter: one record by its _id
 * (scopedFindById), a relation's keys under the other module's own scope
 * (scopedDistinct, capped), and the named totals (scopedAggregate, whose
 * stages after the scoped $match may only reshape what it matched). Record
 * ids the other query files hold as text become ObjectIds only here
 * (idCondition). */

/** maxTimeMS on every executor Q query (find, countDocuments, aggregate). */
export const QUERY_MAX_TIME_MS = 3000;

/** The caller's scope built nothing for this module; nothing is read. */
export class ScopeFailClosedError extends Error {
  constructor(message = 'The data scope for this module could not be built; nothing was read.') {
    super(message);
    this.name = 'ScopeFailClosedError';
  }
}

/** contactOwnerValues for one request: looked up once per ExecContext. */
const ownerValuesByContext = new WeakMap<ExecContext, Promise<string[]>>();

function ownerValuesFor(ctx: ExecContext): () => Promise<string[]> {
  return () => {
    let values = ownerValuesByContext.get(ctx);
    if (!values) {
      values = contactOwnerValues(ctx.identity.userId);
      ownerValuesByContext.set(ctx, values);
    }
    return values;
  };
}

/** The values a contact's contactOwner may hold for this caller (userId,
 * "First Last", User.name): the same lookup, and the same memo, as the
 * contact scope closure, so "contacts I own" and the scope agree. */
export function contactOwnerValuesFor(ctx: ExecContext): Promise<string[]> {
  return ownerValuesFor(ctx)();
}

/** resolveOwnStaffId for one request: looked up once per ExecContext. */
const ownStaffIdByContext = new WeakMap<ExecContext, Promise<string | null>>();
const OBJECT_ID_TEXT = /^[a-f0-9]{24}$/i;

/** The caller's own staffId (the staffId of the NativeStaff profile linked to
 * their user), null when they have none. A userId that isn't an ObjectId can't
 * be linked to a profile (resolveOwnStaffId would throw on it), so it has none
 * and nothing is read. A lookup that fails rejects: a failed read is reported
 * as one, never as "you have no staff profile". */
export function ownStaffIdFor(ctx: ExecContext): Promise<string | null> {
  let lookup = ownStaffIdByContext.get(ctx);
  if (!lookup) {
    const { tenantId } = ctx;
    const { userId } = ctx.identity;
    lookup = OBJECT_ID_TEXT.test(tenantId) && OBJECT_ID_TEXT.test(userId)
      ? resolveOwnStaffId(tenantId, userId).then((found) => (typeof found === 'string' && found ? found : null))
      : Promise.resolve(null);
    ownStaffIdByContext.set(ctx, lookup);
  }
  return lookup;
}

/** True when the module's schema records who created each record (a createdBy
 * path), the only way "created by me" can be told. Schema metadata; no read. */
export function recordsCreatedBy(cap: ModuleCap): boolean {
  try {
    return !!cap.model().schema.path('createdBy');
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** { $and: [ { tenantId, branchId? }, scopeObject, ...conditions ] }. The scope
 * object is the closure's output, untouched; each condition is its own member. */
export async function scopedFilter(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[],
): Promise<{ filter: { $and: Record<string, unknown>[] }; scopeObject: Record<string, unknown> }> {
  const qc = queryCapsFor(cap.key);
  if (!qc || !qc.q) throw new Error(`Executor Q does not read "${cap.key}".`);

  let built: unknown;
  try {
    built = await qc.scope(ctx.scope, { userId: ctx.identity.userId, ownerValues: ownerValuesFor(ctx) });
  } catch {
    throw new ScopeFailClosedError(`The data scope for ${cap.labels.plural} could not be built; nothing was read.`);
  }
  if (!isPlainRecord(built)) {
    throw new ScopeFailClosedError(`The data scope for ${cap.labels.plural} could not be built; nothing was read.`);
  }
  const scopeObject = built;
  if (ctx.scope.kind !== 'all' && Object.keys(scopeObject).length === 0) {
    throw new ScopeFailClosedError(`The data scope for ${cap.labels.plural} matched nothing to narrow by; nothing was read.`);
  }

  const base: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(ctx.tenantId) };
  if (qc.branch && ctx.branchId) base.branchId = new mongoose.Types.ObjectId(ctx.branchId);
  return { filter: { $and: [base, scopeObject, ...conditions] }, scopeObject };
}

/** The collation the module's own list() reads with (QueryCaps.collation), as a
 * fresh object per query; undefined for the simple collation. Every read of one
 * plan (find, count, breakdown) uses it, since it changes how strings match too. */
function collationOf(cap: ModuleCap): { locale: string; strength: number } | undefined {
  const collation = queryCapsFor(cap.key)?.collation;
  return collation ? { ...collation } : undefined;
}

/** aggregate() options: maxTimeMS, plus the module's list() collation. */
function aggregateOptions(cap: ModuleCap): { maxTimeMS: number; collation?: { locale: string; strength: number } } {
  const collation = collationOf(cap);
  return { maxTimeMS: QUERY_MAX_TIME_MS, ...(collation ? { collation } : {}) };
}

/** A page of records (plain objects), sorted, skipped and limited, with the
 * collation and populated references of the module's own list(). Schema
 * virtuals the model adds to toObject() (the invoice balanceDue) are filled in,
 * and the module's own step after its read runs (QueryCaps.afterRead: deal
 * contact and company names), as the module's own list() returns them. */
const staticDefaultsCache = new WeakMap<object, ReadonlyArray<[string, unknown]>>();

/** The schema's top-level paths with a static (non-function) default: what a
 * Mongoose document shows for a value the stored record lacks. Function defaults
 * (Date.now, generated ids) are left out: they would invent a value, not a default. */
function staticDefaults(model: { schema: { eachPath(fn: (path: string, type: unknown) => void): void } }): ReadonlyArray<[string, unknown]> {
  const cached = staticDefaultsCache.get(model.schema);
  if (cached) return cached;
  const out: Array<[string, unknown]> = [];
  model.schema.eachPath((path, type) => {
    if (path.includes('.') || path === '_id' || path === '__v') return;
    const value = (type as { defaultValue?: unknown } | undefined)?.defaultValue;
    if (value === undefined || typeof value === 'function') return;
    out.push([path, value]);
  });
  staticDefaultsCache.set(model.schema, out);
  return out;
}

/** Lean rows with the schema's static defaults filled in where the stored record has no value. */
function withSchemaDefaults(model: Parameters<typeof staticDefaults>[0], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const defaults = staticDefaults(model);
  if (!defaults.length) return rows;
  return rows.map((row) => {
    let out = row;
    for (const [path, value] of defaults) {
      if (out[path] !== undefined) continue;
      if (out === row) out = { ...row };
      out[path] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
    return out;
  });
}

export async function scopedFind(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[],
  opts: { sort: Record<string, 1 | -1>; skip: number; limit: number },
): Promise<Record<string, unknown>[]> {
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const model = cap.model();
  const query = model.find(filter).sort(opts.sort);
  const collation = collationOf(cap);
  if (collation) query.collation(collation);
  query.skip(opts.skip).limit(opts.limit).maxTimeMS(QUERY_MAX_TIME_MS);
  for (const ref of queryCapsFor(cap.key)?.populate ?? []) query.populate(ref.path, ref.select);
  const rows = await query.lean() as Record<string, unknown>[];
  const list = Array.isArray(rows) ? rows : [];
  const toObject = (model.schema as unknown as { options?: { toObject?: { virtuals?: unknown } } } | undefined)?.options?.toObject;
  // A hydrated document fills the schema's defaults itself; a lean row of a module
  // whose list() returns documents gets the same static defaults (listDocuments).
  const read = toObject?.virtuals
    ? list.map((row) => (model.hydrate(row) as unknown as { toObject(): Record<string, unknown> }).toObject())
    : queryCapsFor(cap.key)?.listDocuments ? withSchemaDefaults(model, list) : list;
  const afterRead = queryCapsFor(cap.key)?.afterRead;
  return afterRead ? afterRead(ctx.tenantId, read) : read;
}

/** countDocuments on the same filter shape (and collation) scopedFind reads. */
export async function scopedCount(cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[]): Promise<number> {
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const query = cap.model().countDocuments(filter).maxTimeMS(QUERY_MAX_TIME_MS);
  const collation = collationOf(cap);
  if (collation) query.collation(collation);
  const n: unknown = await query;
  return n as number;
}

/** Counts per group: $match (the scoped filter), $group by `by`, then
 * `addFields` (values computed per group to sort by: a date bucket's distance
 * from today's), $sort, $limit. */
export async function scopedGroup(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[],
  opts: { by: unknown; addFields?: Record<string, unknown>; sort: Record<string, 1 | -1>; limit: number },
): Promise<Array<{ _id: unknown; n: number }>> {
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const rows = await cap.model().aggregate([
    { $match: filter },
    { $group: { _id: opts.by, n: { $sum: 1 } } },
    ...(opts.addFields ? [{ $addFields: opts.addFields }] : []),
    { $sort: opts.sort },
    { $limit: opts.limit },
  ]).option(aggregateOptions(cap)) as Array<{ _id: unknown; n: number }>;
  return Array.isArray(rows) ? rows : [];
}

/** How many groups `by` makes over the scoped filter (scopedGroup returns at most its limit). */
export async function scopedGroupCount(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[], by: unknown,
): Promise<number> {
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const rows = await cap.model().aggregate([
    { $match: filter },
    { $group: { _id: by } },
    { $count: 'n' },
  ]).option(aggregateOptions(cap)) as Array<{ n?: unknown }>;
  const n = Array.isArray(rows) ? rows[0]?.n : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/* ── Increment 5: one record by id, relation keys, named totals ────────── */

/** A record id as text: 24 hex characters, as String(ObjectId) writes it. */
export function isObjectIdText(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_TEXT.test(value);
}

/** `path` in (or not in) the record ids given as hex text, as ObjectIds;
 * anything that isn't an id is left out, so it can only match less. */
export function idCondition(path: string, ids: readonly string[], op: 'in' | 'nin' = 'in'): Record<string, unknown> {
  const unique = [...new Set(ids.filter(isObjectIdText).map((id) => id.toLowerCase()))];
  return { [path]: { [op === 'in' ? '$in' : '$nin']: unique.map((id) => new mongoose.Types.ObjectId(id)) } };
}

/** One record by its _id, read exactly as scopedFind reads a page (the
 * caller's closed scope and branch, list()'s populate, defaults and after-read
 * step); null when `id` isn't an id or the caller can't see the record. A
 * contact is read under its contactOwner scope this way, as its list is. */
export async function scopedFindById(cap: ModuleCap, ctx: ExecContext, id: string): Promise<Record<string, unknown> | null> {
  if (!isObjectIdText(id)) return null;
  const rows = await scopedFind(cap, ctx, [idCondition('_id', [id])], { sort: { _id: 1 }, skip: 0, limit: 1 });
  return rows[0] ?? null;
}

/** A schema path the engine wrote itself (relations, metrics): never a "$" or an empty part. */
const SAFE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

function keyText(value: unknown): string | null {
  if (typeof value === 'string') return value ? value : null;
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** The distinct values `path` holds over the scoped filter, as text (an
 * ObjectId as its hex), blanks left out, in ascending order: at most `limit`,
 * with `more` when there were more. `unwind` reads each value of a list field
 * (staffIds). query/relations.ts reads a relation's keys this way, under the
 * child module's own scope. */
export async function scopedDistinct(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[], path: string,
  opts: { limit: number; unwind?: boolean },
): Promise<{ values: string[]; more: boolean }> {
  if (!SAFE_PATH.test(path)) throw new Error(`"${path}" is not a field path.`);
  const limit = Math.max(1, Math.floor(opts.limit));
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const rows = await cap.model().aggregate([
    { $match: filter },
    ...(opts.unwind ? [{ $unwind: `$${path}` }] : []),
    { $group: { _id: `$${path}` } },
    { $match: { _id: { $nin: [null, ''] } } },
    { $sort: { _id: 1 } },
    { $limit: limit + 1 },
  ]).option(aggregateOptions(cap)) as Array<{ _id: unknown }>;
  const list = Array.isArray(rows) ? rows : [];
  const values = list.slice(0, limit).map((row) => keyText(row._id)).filter((v): v is string => v !== null);
  return { values, more: list.length > limit };
}

/** Stages that only reshape the documents the scoped $match already matched.
 * Never $lookup, $graphLookup or $unionWith (they read other records, outside
 * the scope) or $out and $merge (they write). */
const RESHAPING_STAGES: ReadonlySet<string> = new Set([
  '$match', '$group', '$sort', '$limit', '$skip', '$project', '$addFields', '$set', '$unwind', '$count', '$facet',
]);

function checkStages(stages: readonly unknown[]): void {
  for (const stage of stages) {
    const keys = isPlainRecord(stage) ? Object.keys(stage) : [];
    if (keys.length !== 1 || !RESHAPING_STAGES.has(keys[0])) {
      throw new Error(`The stage ${keys.join(',') || '(none)'} may not follow the scoped filter.`);
    }
    if (keys[0] === '$facet') {
      const facets = (stage as Record<string, unknown>).$facet;
      if (!isPlainRecord(facets)) throw new Error('A $facet stage needs its pipelines.');
      for (const pipeline of Object.values(facets)) {
        if (!Array.isArray(pipeline)) throw new Error('A $facet pipeline must be a list of stages.');
        checkStages(pipeline);
      }
    }
  }
}

/** aggregate() over the scoped filter: { $match: <scoped filter> } first, then
 * `stages`, which may only reshape what it matched (RESHAPING_STAGES; any
 * other stage throws before anything is read). With the module's list()
 * collation and maxTimeMS. query/metrics.ts sums the named totals this way. */
export async function scopedAggregate(
  cap: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[], stages: readonly Record<string, unknown>[],
): Promise<unknown[]> {
  checkStages(stages);
  const { filter } = await scopedFilter(cap, ctx, conditions);
  const pipeline = [{ $match: filter }, ...stages] as unknown as mongoose.PipelineStage[];
  const rows: unknown = await cap.model().aggregate(pipeline).option(aggregateOptions(cap));
  return Array.isArray(rows) ? rows : [];
}

/** The FS currency a settings document stands for: its own, else the
 * schema default getSettings also falls back to. */
function currencyOf(doc: { currency?: unknown } | null | undefined): string {
  const value = typeof doc?.currency === 'string' ? doc.currency.trim().toUpperCase() : '';
  return value || 'INR';
}

/** The tenant's Field Service currencies, from one read of its FS settings
 * (org and every company's):
 *   all       the distinct currencies; a tenant without org settings counts
 *             the default getSettings falls back to (for amount comparisons
 *             across companies);
 *   org       what a company without settings of its own uses: the org
 *             settings' currency, else the default INR;
 *   byBranch  each company whose own currency differs from the org's, by its
 *             branchId as hex text.
 * Read only. */
export interface CompanyCurrencies { all: string[]; org: string; byBranch: ReadonlyMap<string, string> }

export async function companyCurrencies(tenantId: string): Promise<CompanyCurrencies> {
  const docs = await FSSettings.find({ tenantId: new mongoose.Types.ObjectId(tenantId) })
    .select('branchId currency')
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean() as Array<{ branchId?: unknown; currency?: unknown }>;
  const list = Array.isArray(docs) ? docs : [];
  const isOrg = (d: { branchId?: unknown }) => d.branchId === null || d.branchId === undefined;
  const all = new Set<string>();
  if (!list.some(isOrg)) all.add(currencyOf(null));
  for (const doc of list) all.add(currencyOf(doc));
  const org = currencyOf(list.find(isOrg));
  const byBranch = new Map<string, string>();
  for (const doc of list) {
    const id = doc.branchId instanceof mongoose.Types.ObjectId ? doc.branchId.toHexString()
      : isObjectIdText(String(doc.branchId ?? '')) ? String(doc.branchId).toLowerCase() : null;
    const currency = currencyOf(doc);
    if (id && currency !== org && !byBranch.has(id)) byBranch.set(id, currency);
  }
  return { all: [...all].sort(), org, byBranch };
}

/** companyCurrencies for one request: read once per ExecContext, so the named
 * totals, a list's per-record currencies and whether its amounts can be
 * ranked all come from the same read. */
const currenciesByContext = new WeakMap<object, Promise<CompanyCurrencies>>();

export function companyCurrenciesFor(ctx: Pick<ExecContext, 'tenantId'>): Promise<CompanyCurrencies> {
  let read = currenciesByContext.get(ctx);
  if (!read) {
    read = companyCurrencies(ctx.tenantId);
    currenciesByContext.set(ctx, read);
  }
  return read;
}

/** Distinct FS currencies of the tenant (companyCurrencies' `all`). Read only. */
export async function tenantCurrencies(tenantId: string): Promise<string[]> {
  return (await companyCurrencies(tenantId)).all;
}

/** Each record's Field Service currency, as an aggregation expression on its
 * branchId: its company's (branch's) FS settings currency, else the org
 * settings' (what getSettings falls back to for a company without its own),
 * else the default INR. A fixed currency when every company uses the org's.
 * Currencies are literals, never field paths. */
export function currencyExpressionOf(currencies: CompanyCurrencies): Record<string, unknown> {
  if (!currencies.byBranch.size) return { $literal: currencies.org };
  return {
    $switch: {
      branches: [...currencies.byBranch].map(([id, currency]) => ({
        case: { $eq: ['$branchId', new mongoose.Types.ObjectId(id)] }, then: { $literal: currency },
      })),
      default: { $literal: currencies.org },
    },
  };
}

/** currencyExpressionOf the tenant's currencies, read here. Read only. */
export async function branchCurrencyExpression(tenantId: string): Promise<Record<string, unknown>> {
  return currencyExpressionOf(await companyCurrencies(tenantId));
}

/* ── Executor L's record-number lookup (Increment 1, unchanged) ────────── */

/** Ids of the records carrying `number` in the caller's tenant (and branch,
 * where the module has one), newest first, at most `limit`. Ids only: executor
 * L then reads each through the module's own getById under the caller's scope
 * (execute-list.ts executeDetailByNumber), so nothing here is shown. */
export async function recordIdsByNumber(
  cap: ModuleCap, ctx: Pick<ExecContext, 'tenantId' | 'branchId'>, field: string, number: string, limit: number,
): Promise<Array<{ _id: unknown }>> {
  const model = cap.model();
  const filter: Record<string, unknown> = { tenantId: new mongoose.Types.ObjectId(ctx.tenantId), [field]: number };
  if (ctx.branchId && model.schema.path('branchId')) filter.branchId = new mongoose.Types.ObjectId(ctx.branchId);
  const rows: unknown = await model.find(filter).select('_id').sort({ createdAt: -1 }).limit(limit).lean();
  return rows as Array<{ _id: unknown }>;
}

/** The schema's own enum values for `path` (executor L's status labels fall
 * back to them when the registry has none). Schema metadata only; no read. */
export function schemaEnumValues(cap: ModuleCap, path: string): string[] {
  try {
    const schemaPath: any = cap.model().schema.path(path);
    return Array.isArray(schemaPath?.enumValues) ? [...schemaPath.enumValues] : [];
  } catch {
    return [];
  }
}
