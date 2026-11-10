import mongoose from 'mongoose';
import { CustomModuleDef, CustomRecord } from '../../custom-modules/custom-module.model';
import { QUERY_MAX_TIME_MS } from './scoped-match';

/* Executor M's one way into the database (Increment 5, LD5): the tenant's
 * Custom Module definitions and their records. Besides scoped-match.ts, the
 * only file under crm-assistant/query that touches a Mongoose model
 * (tests/crm-assist-scoped-match.test.ts guards this). Every record read has
 * one filter shape:
 *
 *   { $and: [ { tenantId, moduleSlug }, ...conditions ] }
 *
 * Custom Module records have no DataScope and no branch (the screens and the
 * internal routes have none either: everyone with access sees all of them),
 * so the base is the tenant and the module; each condition (execute-custom.ts)
 * is its own member and can only narrow it. Every read carries maxTimeMS
 * QUERY_MAX_TIME_MS. Reads only: listCustomRecords (which sends the raw search
 * text as a regex and has no lower bound on its limit) is never called, nor
 * any pipeline stage writer (getOrCreateStages, isValidStageKey). */

/** At most this many module definitions are read per tenant. */
export const MAX_CUSTOM_MODULE_DEFS = 200;

/** The definition paths the registry needs (registry/custom-modules.ts). */
const DEF_PATHS = 'slug name singularName showInSidebar fields.key fields.label fields.fieldType fields.options fields.meta.targetModule';

/** A definition as stored: every value is checked where it is used. */
export interface RawCustomModuleDef {
  slug?: unknown;
  name?: unknown;
  singularName?: unknown;
  showInSidebar?: unknown;
  fields?: unknown;
}

/** The same slug rule as registry/custom-modules.ts: lower-case letters, digits and hyphens. */
const SLUG_RE = /^[a-z0-9-]{1,113}$/;

function tenantObjectId(tenantId: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(tenantId);
}

/** The tenant's module definitions in sidebar order (menuOrder, then oldest
 * first, as listCustomModules sorts them), only the paths the registry needs. */
export async function readCustomModuleDefs(tenantId: string): Promise<RawCustomModuleDef[]> {
  const rows: unknown = await CustomModuleDef.find({ tenantId: tenantObjectId(tenantId) })
    .select(DEF_PATHS)
    .sort({ menuOrder: 1, createdAt: 1, _id: 1 })
    .limit(MAX_CUSTOM_MODULE_DEFS)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean();
  return Array.isArray(rows) ? rows as RawCustomModuleDef[] : [];
}

/** Whether the tenant still has a module with this slug: one read by the
 * definitions' unique { tenantId, slug } index, made before an answer of no
 * records from cached definitions (a module deleted since has none). */
export async function customModuleExists(tenantId: string, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) throw new Error('Not a Custom Module slug.');
  const found: unknown = await CustomModuleDef.exists({ tenantId: tenantObjectId(tenantId), slug }).maxTimeMS(QUERY_MAX_TIME_MS);
  return found !== null && found !== undefined;
}

/** { $and: [ { tenantId, moduleSlug }, ...conditions ] }. */
export function customFilter(tenantId: string, slug: string, conditions: Record<string, unknown>[]): { $and: Record<string, unknown>[] } {
  if (!SLUG_RE.test(slug)) throw new Error('Not a Custom Module slug.');
  return { $and: [{ tenantId: tenantObjectId(tenantId), moduleSlug: slug }, ...conditions] };
}

/** A page of records, sorted (by stored fields of one type: the creation date), skipped and limited, with only the paths in `select`. */
export async function customFind(
  tenantId: string, slug: string, conditions: Record<string, unknown>[],
  opts: { sort: Record<string, 1 | -1>; skip: number; limit: number; select: Record<string, 1> },
): Promise<Record<string, unknown>[]> {
  const rows: unknown = await CustomRecord.find(customFilter(tenantId, slug, conditions))
    .select(opts.select)
    .sort(opts.sort)
    .skip(opts.skip)
    .limit(opts.limit)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean();
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

/** The computed field a page sorted by a record field is ordered by (customFindByKey). */
const SORT_KEY = '__sortKey';

/** A page sorted by a computed key, then _id: record values are stored as
 * given (Mixed), so a sort by a field orders by `key`, the value when it is of
 * the field's own type and null otherwise (execute-custom.ts), never by
 * Mongo's order across types (a blank string would rank above every amount). */
export async function customFindByKey(
  tenantId: string, slug: string, conditions: Record<string, unknown>[],
  opts: { key: unknown; dir: 1 | -1; skip: number; limit: number; select: Record<string, 1> },
): Promise<Record<string, unknown>[]> {
  const rows: unknown = await CustomRecord.aggregate([
    { $match: customFilter(tenantId, slug, conditions) },
    { $addFields: { [SORT_KEY]: opts.key } },
    { $sort: { [SORT_KEY]: opts.dir, _id: opts.dir } },
    ...(opts.skip > 0 ? [{ $skip: opts.skip }] : []),
    { $limit: opts.limit },
    { $project: opts.select },
  ]).option({ maxTimeMS: QUERY_MAX_TIME_MS });
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

/** countDocuments on the same filter customFind reads. */
export async function customCount(tenantId: string, slug: string, conditions: Record<string, unknown>[]): Promise<number> {
  const n: unknown = await CustomRecord.countDocuments(customFilter(tenantId, slug, conditions)).maxTimeMS(QUERY_MAX_TIME_MS);
  return n as number;
}

/** Counts per value of `by`, most first (ties by value), at most `limit`. */
export async function customGroup(
  tenantId: string, slug: string, conditions: Record<string, unknown>[], opts: { by: unknown; limit: number },
): Promise<Array<{ _id: unknown; n: number }>> {
  const rows: unknown = await CustomRecord.aggregate([
    { $match: customFilter(tenantId, slug, conditions) },
    { $group: { _id: opts.by, n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: opts.limit },
  ]).option({ maxTimeMS: QUERY_MAX_TIME_MS });
  return Array.isArray(rows) ? rows as Array<{ _id: unknown; n: number }> : [];
}

/** How many groups `by` makes over the same filter (customGroup returns at most its limit). */
export async function customGroupCount(
  tenantId: string, slug: string, conditions: Record<string, unknown>[], by: unknown,
): Promise<number> {
  const rows: unknown = await CustomRecord.aggregate([
    { $match: customFilter(tenantId, slug, conditions) },
    { $group: { _id: by } },
    { $count: 'n' },
  ]).option({ maxTimeMS: QUERY_MAX_TIME_MS });
  const n = Array.isArray(rows) ? (rows[0] as { n?: unknown } | undefined)?.n : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
