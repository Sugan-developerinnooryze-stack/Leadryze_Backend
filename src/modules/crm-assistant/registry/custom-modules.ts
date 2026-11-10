import type { CondOp } from './query-caps';
import { synonymIndex } from './index';
import { GateIdentity, GatewayTenant, checkModuleRead, identityHasPermission, meetsRoleIdRule } from '../gates';
import { CUSTOM_MODULES_FLAG } from '../../internal/crm-gateway.helpers';
import { RawCustomModuleDef, customModuleExists, readCustomModuleDefs } from '../query/custom-match';
import { logger } from '../../../utils/logger';

/* The tenant's Custom Modules as the assistant reads them (Increment 5, LD5:
 * executor M). Unlike the built-in modules these are defined per tenant, so
 * the entries are built from the stored definitions (query/custom-match.ts),
 * cached 60 s per tenant and only ever read: no pipeline stage is created or
 * checked here (getOrCreateStages and isValidStageKey write). An answer of no
 * records first confirms its module is still defined (customModuleStillDefined).
 *
 * Each module is keyed "custom:<slug>" (real slugs are hyphenated:
 * "site-visits"). Only the fields of the current definition are offered, as
 * data.<key>: values of fields removed since stay in the records and are never
 * read. How each field type is read:
 *   text, textarea, url, relationship  text (relationship: the stored value,
 *                                      no join; matched by record number only;
 *                                      one that stores an _id is never searched
 *                                      or sorted)
 *   number, currency                   number (no currency code is stored)
 *   date                               "YYYY-MM-DD" strings
 *   datetime                           local "YYYY-MM-DDTHH:mm" strings
 *   select / multiselect               one of / any of its options
 *   boolean                            yes or no ('' or missing = never set,
 *                                      which the form shows as "No")
 *   email, phone                       never (stored unmasked: PII)
 *   image, images, table, categoryselect, rating   never (not table values)
 * A record is named by data.name, else data.title, else its recordId, which is
 * not unique and has no tenant prefix, so it is never a lookup key.
 *
 * Access (customModuleAccess) needs the config_customModules flag and both
 * custom_modules.records.view and custom_modules.definitions.view: the app
 * shows a module's records only to callers who can read its definition (an
 * Agent holds records.view alone and sees no Custom Modules on the screens).
 * There is no DataScope and no branch: everyone with access sees every record. */

/** How executor M reads a field. */
export type CustomFieldKind = 'text' | 'number' | 'date' | 'datetime' | 'enum' | 'multi' | 'boolean';

export interface CustomFieldInfo {
  /** The key plans use (contracts/plan.ts FieldKeySchema): "data.<field key>",
   * or "createdAt" for the record's creation date. */
  key: string;
  /** The Mongo path; equal to key. */
  path: string;
  /** The definition's own key: a record keeps the value in data[fieldKey]. */
  fieldKey: string;
  label: string;
  kind: CustomFieldKind;
  /** The definition's field type ('textarea', 'currency', 'relationship', ...; 'createdAt' for the creation date). */
  fieldType: string;
  /** select and multiselect: the values a condition may name, exactly as stored. */
  options?: readonly string[];
  /** Relationship fields whose stored value is a record number of this
   * registry module (a customer's customerId, ...): a condition must name
   * that number. Other relationship fields take only empty / not_empty. */
  refModule?: string;
  /** Operators a condition may use; [] = none. */
  ops: readonly CondOp[];
  sortable: boolean;
  /** "Count by": dropdown and yes/no fields. */
  groupable: boolean;
  /** Part of the escaped text search. */
  searchable: boolean;
  /** The record's own creation date (a stored Date), not a field of the definition. */
  system?: true;
}

export interface CustomModuleInfo {
  /** "custom:<slug>": a plan's target.module and the SourceRef module. */
  key: string;
  slug: string;
  /** The module's (plural) name as the sidebar shows it, and its singular name. */
  name: string;
  singular: string;
  /** Lower-case words naming the module (its name and singular name) for the grammar. */
  words: readonly string[];
  /** Fields of the current definition that are read or shown, in definition order. */
  fields: readonly CustomFieldInfo[];
  /** The creation date: conditions and sort, and the table's "Created" column. */
  created: CustomFieldInfo;
  /** The fields that name a record, in order: data.name, then data.title (where defined). */
  titleFields: readonly CustomFieldInfo[];
  /** The table's field columns: the first title field and the first other fields,
   * at most MAX_CUSTOM_FIELD_COLUMNS, in definition order (the module's page shows its first six). */
  columns: readonly CustomFieldInfo[];
  /** False when the module is hidden from the sidebar (its page still opens by link). */
  inSidebar: boolean;
}

export type CustomModuleAccess = 'ok' | 'disabled' | 'no_permission' | 'tenant_inactive';

export const CUSTOM_RECORDS_VIEW = 'custom_modules.records.view';
export const CUSTOM_DEFINITIONS_VIEW = 'custom_modules.definitions.view';

/** How long a tenant's definitions are reused. */
export const CUSTOM_MODULE_TTL_MS = 60_000;
/** Field columns per table besides the record id and the creation date (8 columns at most). */
export const MAX_CUSTOM_FIELD_COLUMNS = 6;

const KEY_PREFIX = 'custom:';
/** Lower-case letters, digits and hyphens (the slug custom-module.service.ts makes); the key stays within 120 characters. */
const SLUG_RE = /^[a-z0-9-]{1,113}$/;
/** A field key that fits "data.<key>" in a plan (FieldKeySchema, at most 80 characters). */
const FIELD_KEY_RE = /^[A-Za-z0-9_]{1,75}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MAX_OPTIONS = 200;
/** A plan's condition value is at most 200 characters (contracts/plan.ts ScalarSchema). */
const MAX_OPTION_CHARS = 200;
const MAX_LABEL = 120;
const MAX_CACHED_TENANTS = 2000;

const TEXT_OPS: readonly CondOp[] = Object.freeze(['eq', 'ne', 'in', 'nin', 'contains', 'empty', 'not_empty'] as CondOp[]);
const NUMBER_OPS: readonly CondOp[] = Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'] as CondOp[]);
const DATE_OPS: readonly CondOp[] = Object.freeze(['gt', 'gte', 'lt', 'lte', 'between', 'within', 'empty', 'not_empty'] as CondOp[]);
const CHOICE_OPS: readonly CondOp[] = Object.freeze(['eq', 'ne', 'in', 'nin', 'empty', 'not_empty'] as CondOp[]);
const BOOL_OPS: readonly CondOp[] = Object.freeze(['eq', 'ne', 'empty', 'not_empty'] as CondOp[]);
const SET_OPS: readonly CondOp[] = Object.freeze(['empty', 'not_empty'] as CondOp[]);
const CREATED_OPS: readonly CondOp[] = Object.freeze(['gt', 'gte', 'lt', 'lte', 'between', 'within'] as CondOp[]);

/** Relationship targets whose stored value is the target's record number
 * (custom-module.service.ts RELATIONSHIP_LOOKUP valueField), by registry module.
 * Services, categories, deals and branches store an _id, and a custom target
 * its recordId: those are never matched by a value. */
const NUMBERED_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  customers: 'customer', staffs: 'staff', teams: 'team', sites: 'site', workorders: 'workorder', quotations: 'quotation',
  parts: 'part', expenses: 'expense', products: 'product', assets: 'asset', vehicles: 'vehicle', leads: 'lead',
});
/** Relationship targets that store the target's _id (RELATIONSHIP_LOOKUP
 * valueField '_id'): the table never shows a 24-hex id, so these are neither
 * searched nor sorted (a search would match hidden ids, a sort order by them). */
const ID_TARGETS: ReadonlySet<string> = new Set(['services', 'categories', 'deals', 'branches']);

const TITLE_KEYS = ['name', 'title'];

/** The record's creation date (timestamps), the same for every module. */
const CREATED: CustomFieldInfo = Object.freeze({
  key: 'createdAt', path: 'createdAt', fieldKey: 'createdAt', label: 'Created', kind: 'datetime' as const, fieldType: 'createdAt',
  ops: CREATED_OPS, sortable: true, groupable: false, searchable: false, system: true as const,
});

/* ── Keys ──────────────────────────────────────────────────────────────── */

export function customModuleKey(slug: string): string {
  return `${KEY_PREFIX}${slug}`;
}

/** True for "custom:<slug>" with a slug the app can make. */
export function isCustomModuleKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && SLUG_RE.test(key.slice(KEY_PREFIX.length));
}

/** The plan key's field (data.<key> or createdAt), or undefined. */
export function customFieldFor(info: CustomModuleInfo, key: string): CustomFieldInfo | undefined {
  if (key === CREATED.key) return info.created;
  return info.fields.find((f) => f.key === key);
}

/** The planner catalog's kind letter (contracts/plan.ts PLANNER_FIELD_KINDS). */
export function customFieldLetter(field: CustomFieldInfo): 'n' | 'd' | 's' | 'e' | 'b' {
  switch (field.kind) {
    case 'number': return 'n';
    case 'date': case 'datetime': return 'd';
    case 'enum': case 'multi': return 'e';
    case 'boolean': return 'b';
    default: return 's';
  }
}

/* ── Definitions ───────────────────────────────────────────────────────── */

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** A name as the grammar compares words: NFKC, lower case, single spaces. */
function wordOf(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function kindOf(fieldType: string): CustomFieldKind | null {
  switch (fieldType) {
    case 'text': case 'textarea': case 'url': case 'relationship': return 'text';
    case 'number': case 'currency': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'select': return 'enum';
    case 'multiselect': return 'multi';
    case 'boolean': return 'boolean';
    // email and phone are stored unmasked (PII); image, images, table,
    // categoryselect and rating are not table values.
    default: return null;
  }
}

function optionsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_OPTION_CHARS || out.includes(value)) continue;
    out.push(value);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function fieldInfo(raw: unknown): CustomFieldInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const def = raw as { key?: unknown; label?: unknown; fieldType?: unknown; options?: unknown; meta?: { targetModule?: unknown } };
  const fieldKey = typeof def.key === 'string' ? def.key : '';
  const fieldType = typeof def.fieldType === 'string' ? def.fieldType : '';
  const kind = kindOf(fieldType);
  if (!kind || !FIELD_KEY_RE.test(fieldKey)) return null;
  const key = `data.${fieldKey}`;
  const label = clip(trimmed(def.label) || humanize(fieldKey), MAX_LABEL);
  const base = { key, path: key, fieldKey, label, kind, fieldType };
  switch (kind) {
    case 'number': return { ...base, ops: NUMBER_OPS, sortable: true, groupable: false, searchable: false };
    case 'date': case 'datetime': return { ...base, ops: DATE_OPS, sortable: true, groupable: false, searchable: false };
    case 'boolean': return { ...base, ops: BOOL_OPS, sortable: true, groupable: true, searchable: false };
    case 'enum': case 'multi': {
      const options = optionsOf(def.options);
      const multi = kind === 'multi';
      return {
        ...base, options: Object.freeze(options), ops: options.length ? CHOICE_OPS : SET_OPS,
        sortable: !multi, groupable: !multi, searchable: false,
      };
    }
    default: {
      if (fieldType === 'relationship') {
        const target = trimmed(def.meta?.targetModule);
        const refModule = NUMBERED_TARGETS[target];
        const shown = !ID_TARGETS.has(target);
        return { ...base, ...(refModule ? { refModule } : {}), ops: refModule ? CHOICE_OPS : SET_OPS, sortable: shown, groupable: false, searchable: shown };
      }
      // A long text is searched and filtered, not sorted (as a registry longtext).
      return { ...base, ops: TEXT_OPS, sortable: fieldType !== 'textarea', groupable: false, searchable: true };
    }
  }
}

/** One module's entry from its stored definition, or null when its slug can't
 * be named in a plan or a link. Pure. */
export function customModuleInfoFromDef(def: RawCustomModuleDef): CustomModuleInfo | null {
  const slug = typeof def.slug === 'string' ? def.slug : '';
  if (!SLUG_RE.test(slug)) return null;
  const name = clip(trimmed(def.name) || humanize(slug), MAX_LABEL);
  const singular = clip(trimmed(def.singularName) || name, MAX_LABEL);

  const fields: CustomFieldInfo[] = [];
  for (const raw of Array.isArray(def.fields) ? def.fields : []) {
    const field = fieldInfo(raw);
    // A key defined twice keeps its first field.
    if (field && !fields.some((f) => f.fieldKey === field.fieldKey)) fields.push(Object.freeze(field));
  }
  const titleFields = TITLE_KEYS
    .map((k) => fields.find((f) => f.fieldKey === k && f.kind === 'text' && f.fieldType !== 'relationship'))
    .filter((f): f is CustomFieldInfo => !!f);
  const title = titleFields[0];
  const others = fields.filter((f) => f !== title).slice(0, MAX_CUSTOM_FIELD_COLUMNS - (title ? 1 : 0));
  const columns = fields.filter((f) => f === title || others.includes(f));
  const words = [...new Set([wordOf(name), wordOf(singular)].filter(Boolean))];

  return Object.freeze({
    key: customModuleKey(slug),
    slug,
    name,
    singular,
    words: Object.freeze(words),
    fields: Object.freeze(fields),
    created: CREATED,
    titleFields: Object.freeze(titleFields),
    columns: Object.freeze(columns),
    inSidebar: def.showInSidebar !== false,
  });
}

/** Every module of the definitions a slug can name, in their order (a slug seen twice keeps its first). */
export function customModuleInfosFromDefs(defs: readonly RawCustomModuleDef[]): CustomModuleInfo[] {
  const out: CustomModuleInfo[] = [];
  for (const def of defs) {
    const info = customModuleInfoFromDef(def);
    if (info && !out.some((m) => m.key === info.key)) out.push(info);
  }
  return out;
}

const cache = new Map<string, { expiresAt: number; infos: Promise<readonly CustomModuleInfo[]> }>();

/** The tenant's Custom Modules (every definition a slug can name, hidden ones
 * included), read once and reused for 60 s; a failed read rejects and is never
 * served from the cache. `now` (epoch ms) is for tests. Reading them says
 * nothing about access: check customModuleAccess first. */
export function listCustomModuleInfos(tenantId: string, now: number = Date.now()): Promise<readonly CustomModuleInfo[]> {
  if (!OBJECT_ID.test(tenantId)) return Promise.resolve([]);
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.infos;
  if (hit) cache.delete(tenantId);
  if (cache.size >= MAX_CACHED_TENANTS) {
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
    if (cache.size >= MAX_CACHED_TENANTS) cache.delete(cache.keys().next().value as string);
  }
  const infos = readCustomModuleDefs(tenantId).then((defs) => {
    const built = customModuleInfosFromDefs(defs);
    if (built.length < defs.length) {
      logger.warn('CRM assistant: Custom Modules left out (slug not usable)', { tenantId, defined: defs.length, usable: built.length });
    }
    return Object.freeze(built) as readonly CustomModuleInfo[];
  });
  cache.set(tenantId, { expiresAt: now + CUSTOM_MODULE_TTL_MS, infos });
  infos.catch(() => { if (cache.get(tenantId)?.infos === infos) cache.delete(tenantId); });
  return infos;
}

/** One module by its key ("custom:<slug>"), or undefined when the tenant has none by that slug. */
export async function findCustomModule(tenantId: string, key: string): Promise<CustomModuleInfo | undefined> {
  if (!isCustomModuleKey(key)) return undefined;
  return (await listCustomModuleInfos(tenantId)).find((m) => m.key === key);
}

/** Drops one tenant's cached definitions, or every tenant's (tests), so the
 * next question reads them again. */
export function clearCustomModuleCache(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

/** Whether a module from the cached definitions is still defined: one read by
 * tenant and slug, made before answering with no records (LD7: never a
 * confident zero for a module deleted since it was cached). When it is gone,
 * the tenant's cached definitions are dropped, so the next question reads
 * them again and no longer offers it. */
export async function customModuleStillDefined(tenantId: string, info: CustomModuleInfo): Promise<boolean> {
  if (await customModuleExists(tenantId, info.slug)) return true;
  clearCustomModuleCache(tenantId);
  return false;
}

/* ── Access ────────────────────────────────────────────────────────────── */

/** Whether this caller may read Custom Module records, in the gates' order:
 * tenant active, the config_customModules flag (SUPER_ADMIN bypasses it, as
 * requireModuleEnabled does), then custom_modules.records.view and
 * custom_modules.definitions.view (admins bypass both). It covers every
 * module of the tenant: there are no per-module keys. */
export async function customModuleAccess(tenantId: string, identity: GateIdentity, tenant: GatewayTenant): Promise<CustomModuleAccess> {
  const records = await checkModuleRead(tenantId, tenant, identity, {
    flagKey: CUSTOM_MODULES_FLAG.flagKey, label: CUSTOM_MODULES_FLAG.label, viewPermission: CUSTOM_RECORDS_VIEW,
  });
  if (!records.ok) return records.reason;
  // Verified callers meet the roleId rule already (identity.ts); checked again here.
  if (!meetsRoleIdRule(identity)) return 'no_permission';
  return (await identityHasPermission(tenantId, identity, CUSTOM_DEFINITIONS_VIEW)) ? 'ok' : 'no_permission';
}

/** The caller's access, and the tenant's modules only when it is 'ok' (no
 * definition is read otherwise). Rejects when the definitions can't be read. */
export async function customModulesFor(
  tenantId: string, identity: GateIdentity, tenant: GatewayTenant,
): Promise<{ access: CustomModuleAccess; modules: readonly CustomModuleInfo[] }> {
  const access = await customModuleAccess(tenantId, identity, tenant);
  if (access !== 'ok') return { access, modules: [] };
  return { access, modules: await listCustomModuleInfos(tenantId) };
}

/** Registry modules one of whose synonyms is also a word of this Custom Module
 * ("equipment" is an Assets synonym): the grammar asks which one is meant. */
export function registryWordCollisions(info: CustomModuleInfo): string[] {
  const words = new Set(info.words);
  return [...new Set(synonymIndex().filter((s) => words.has(wordOf(s.phrase))).map((s) => s.key))];
}
