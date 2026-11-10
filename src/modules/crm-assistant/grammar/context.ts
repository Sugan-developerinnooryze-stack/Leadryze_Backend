import type { FieldCap, FieldKind, ModuleCap } from '../registry/types';
import { getModuleCap, synonymIndex, usableModuleCaps } from '../registry';
import {
  amountFieldOf, conditionOpsFor, isQueryGroupable, isQuerySortable, queryCapsFor, queryStatesFor,
} from '../registry/query-caps';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import type { BuiltInPipelineModule } from '../../native-crm/pipeline-config/pipeline-config.model';
import { getSettings } from '../../native-crm/fs-settings/fs-settings.service';
import { tenantCurrencies } from '../query/scoped-match';
import { localDateKey } from '../../daily-events/daily-events.time';
import { isValidTimeZone } from '../../native-crm/shared/date-range';
import { logger } from '../../../utils/logger';
import { FS_DEFAULT_CURRENCY } from './numbers';
import type { CustomFieldInfo, CustomModuleInfo } from '../registry/custom-modules';

/* What the grammar knows about the caller's modules (Increment 3, grammar
 * v1): for each module in the caller's capability view, the tenant's stage
 * words (peekStages, which never writes; getOrCreateStages, isValidStageKey
 * and getOutcomeStageKey are never called here), the other enum values a
 * condition may use, the dates, the main amount, what executor Q may sort
 * and group by, and which record states the module supports — all read from
 * the registry entry and registry/query-caps.ts, so the grammar never offers
 * what the plan validator would refuse. Stage words are cached 60 s per
 * tenant. todayKey is the tenant-local date for "in October" and "since
 * Monday". fsCurrency is the Field Service currency the caller's amounts are
 * in (cached 60 s per tenant and branch), so "invoices over ₹5000" is read
 * only where amounts are in rupees. Since Increment 5 also the caller's
 * Custom Modules, gated by the caller before they get here (nothing in
 * grammar/ runs a gate), described from their definitions only
 * (customGrammarModuleInfo). */

export interface StageWord { key: string; label: string; terminal: boolean; outcome: string | null }

export interface GrammarModuleInfo {
  key: string;
  stageField?: string;
  /** The tenant's pipeline stages (peekStages, inactive ones included: old
   * records can sit in them) or the schema enum of the stage field. */
  stages: readonly StageWord[];
  /** Other enum fields a condition may use (conditionOpsFor non-empty). */
  enums: ReadonlyArray<{ field: string; values: readonly string[] }>;
  dates: { default: string; created: string; due?: string; start?: string; end?: string };
  /** amountFieldOf(cap)?.key */
  amountField?: string;
  /** isQuerySortable */
  sortable: ReadonlyArray<{ key: string; label: string; kind: FieldKind }>;
  /** isQueryGroupable */
  groupable: ReadonlyArray<{ key: string; label: string; kind: FieldKind }>;
  /** queryStatesFor (stage spec / due / QueryCaps.expiring); all false when executor Q can't run the module. */
  states: { open: boolean; overdue: boolean; dueToday: boolean; expiring: boolean };
  /** Increment 5, where states.expiring: the end date the 'expiring' state reads (QueryCaps.expiring.field) and
   * which records still run ('active': the stages tagged with the outcome active, else the stage keyed active;
   * 'open': every stage that isn't terminal). */
  expiring?: { field: string; running: 'active' | 'open' };
  q: boolean;
  /** Date fields a condition may use (conditionOpsFor allows 'within').
   * Absent: every date named in `dates` is usable. */
  dateFields?: readonly string[];
  /** What the module's list returns when no sort is asked (cap.sort.default):
   * "latest customers" needs no sort when that is newest first. */
  defaultSort?: { by: string; dir: 'asc' | 'desc' };
  /** The field holding the currency of `amountField` when the module has one
   * (deal: 'currency'), so "$50,000" can keep the comparison in dollars. */
  amountCurrencyField?: string;
  /** Increment 5: a Custom Module's own entry (customGrammarModuleInfo), whose
   * records are read by executor M: never "mine", a relation or a record
   * number; its yes/no fields and dates are named by their labels. */
  custom?: CustomModuleInfo;
}

export interface GrammarContext {
  /** Lower-case synonym phrases with their module key (registry synonymIndex()). */
  synonyms: ReadonlyArray<{ phrase: string; key: string }>;
  /** The module's sidebar group, or undefined when the registry doesn't serve it. */
  groupOf(module: string): 'native_crm' | 'field_service' | undefined;
  /** Grammar v1 only. Without it the v1 slots are unknown words (needs_planner), as in grammar v0. */
  moduleInfo?(module: string): GrammarModuleInfo | undefined;
  /** Tenant-local today (YYYY-MM-DD), for "in October", "since Monday", "between 1 and 15 November". */
  todayKey?: string;
  /** Increment 6, the write grammar (write.ts): the request's clock and the
   * tenant's timezone, todayKey's own, for a time from now ("in 2 hours"). */
  now?: Date;
  timezone?: string;
  /** Grammar v1: the Field Service currency the caller's amounts are in: their
   * branch's (getSettings) when a branch is set, else the tenant's only one;
   * null when the tenant's companies use several currencies and no branch is
   * set, or when it couldn't be read. A currency written next to a Field
   * Service amount is believed only when it is this one. */
  fsCurrency?: string | null;
  /** Grammar v1 (Increment 5): the caller's Custom Modules (customModulesFor,
   * only when their access is ok), whose names are module words for
   * 'custom:<slug>' targets. Absent or empty: no custom words. */
  customModules?: readonly CustomModuleInfo[];
}

/* The registry is fixed once validated (usableModuleCaps returns the same
 * list until resetRegistryCache), so its synonym index is built once per
 * list; the parser's phrase tables are cached per index. */
let synonymsFor: { caps: readonly ModuleCap[]; synonyms: GrammarContext['synonyms'] } | null = null;

function registrySynonyms(): GrammarContext['synonyms'] {
  const caps = usableModuleCaps();
  if (!synonymsFor || synonymsFor.caps !== caps) synonymsFor = { caps, synonyms: synonymIndex() };
  return synonymsFor.synonyms;
}

/** Grammar v0's context: registry synonyms and groups, nothing per tenant. */
export function grammarContextFromRegistry(): GrammarContext {
  return { synonyms: registrySynonyms(), groupOf: (module) => getModuleCap(module)?.group };
}

/* ── Stage words ───────────────────────────────────────────────────────── */

export const GRAMMAR_STAGE_TTL_MS = 60_000;
/** How long one parse waits for a pipeline's stages. Later, the module has
 * no stage words for this message (its stage questions go to the existing
 * assistant); the read itself goes on and is cached for the next message.
 * The answer is due within the route's RESOLVE_DEADLINE (3.5 s). */
export const GRAMMAR_STAGE_WAIT = { ms: 1000 };
const MAX_CACHED_PIPELINES = 5000;
const stageCache = new Map<string, { expiresAt: number; words: Promise<readonly StageWord[]> }>();
/** Field Service currencies by tenant and branch (fsCurrencyOf). */
const currencyCache = new Map<string, { expiresAt: number; currency: Promise<string | null> }>();

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** Room for one more entry: expired entries go first, then the oldest. */
function makeRoom(cache: Map<string, { expiresAt: number }>, now: number): void {
  if (cache.size < MAX_CACHED_PIPELINES) return;
  for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
  if (cache.size >= MAX_CACHED_PIPELINES) cache.delete(cache.keys().next().value as string);
}

/** The tenant's stages for one pipeline, as stage words; cached 60 s per tenant. */
function pipelineStageWords(tenantId: string, pipeline: BuiltInPipelineModule): Promise<readonly StageWord[]> {
  const key = `${tenantId}|${pipeline}`;
  const now = Date.now();
  const hit = stageCache.get(key);
  if (hit && hit.expiresAt > now) return hit.words;
  makeRoom(stageCache, now);
  const words = peekStages(tenantId, pipeline).then((stages) => Object.freeze((Array.isArray(stages) ? stages : [])
    .filter((s) => !!s && typeof s.key === 'string' && s.key.trim() !== '')
    .map((s) => Object.freeze({
      key: s.key,
      label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : humanize(s.key),
      terminal: s.isTerminal === true,
      outcome: typeof s.outcome === 'string' && s.outcome.trim() ? s.outcome.trim().toLowerCase() : null,
    }))));
  stageCache.set(key, { expiresAt: now + GRAMMAR_STAGE_TTL_MS, words });
  // A failed read is never served from the cache.
  words.catch(() => { if (stageCache.get(key)?.words === words) stageCache.delete(key); });
  return words;
}

/** For tests and for a pipeline or currency change that must apply at once. */
export function clearGrammarContextCache(): void {
  stageCache.clear();
  currencyCache.clear();
}

/** An ISO currency code as settings hold it, or null when there is none. */
function currencyCode(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return code || null;
}

/** The Field Service currency of the caller's amounts: with a branch, the
 * branch's (getSettings, which falls back to the company's settings and then
 * to the default); without one, the tenant's only currency, or null when its
 * companies use several (tenantCurrencies). Cached 60 s per tenant and
 * branch; a failed read is never served from the cache. */
function fsCurrencyOf(tenantId: string, branchId: string | null): Promise<string | null> {
  const key = `${tenantId}|${branchId ?? ''}`;
  const now = Date.now();
  const hit = currencyCache.get(key);
  if (hit && hit.expiresAt > now) return hit.currency;
  makeRoom(currencyCache, now);
  const currency = branchId
    ? getSettings(tenantId, branchId).then((settings) => currencyCode((settings as { currency?: unknown } | null)?.currency) ?? FS_DEFAULT_CURRENCY)
    : tenantCurrencies(tenantId).then((list) => (Array.isArray(list) && list.length === 1 ? currencyCode(list[0]) : null));
  currencyCache.set(key, { expiresAt: now + GRAMMAR_STAGE_TTL_MS, currency });
  currency.catch(() => { if (currencyCache.get(key)?.currency === currency) currencyCache.delete(key); });
  return currency;
}

function enumValuesOf(cap: ModuleCap, field: FieldCap): string[] {
  let values: unknown = field.schema?.enumValues;
  if (!Array.isArray(values) || !values.length) {
    try {
      values = (cap.model().schema.path(field.path) as { enumValues?: unknown } | undefined)?.enumValues;
    } catch { values = []; }
  }
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

function stageFieldOf(cap: ModuleCap): FieldCap | undefined {
  const field = cap.stage?.field;
  return field ? cap.fields.find((f) => f.key === field || f.path === field) : undefined;
}

/** Schema-enum stages (company, contact, call, meeting and the simple Field
 * Service modules): the enum values, terminal as the registry says. */
function schemaStageWords(cap: ModuleCap): readonly StageWord[] {
  const stage = cap.stage;
  if (!stage || 'pipeline' in stage) return [];
  const field = stageFieldOf(cap);
  if (!field) return [];
  const terminal = new Set(stage.terminal);
  return enumValuesOf(cap, field).map((v) => ({ key: v, label: humanize(v), terminal: terminal.has(v), outcome: null }));
}

/* ── Module info ───────────────────────────────────────────────────────── */

const fieldWord = (f: FieldCap) => ({ key: f.key, label: f.label, kind: f.kind });

/** The grammar's view of one module, given its stage words. Pure. */
export function grammarModuleInfo(cap: ModuleCap, stageWords: readonly StageWord[]): GrammarModuleInfo {
  const qc = queryCapsFor(cap.key);
  const states = queryStatesFor(cap);
  const stageField = stageFieldOf(cap);
  const stageUsable = !!stageField && conditionOpsFor(cap, stageField).includes('in');
  const amount = amountFieldOf(cap);
  const currencySpec = amount?.money?.currency;
  const currencyField = currencySpec && typeof currencySpec === 'object'
    ? cap.fields.find((f) => f.key === currencySpec.field) : undefined;
  return {
    key: cap.key,
    ...(cap.stage ? { stageField: cap.stage.field } : {}),
    stages: stageUsable ? stageWords : [],
    enums: cap.fields
      .filter((f) => f.kind === 'enum' && f !== stageField && conditionOpsFor(cap, f).includes('in'))
      .map((f) => ({ field: f.key, values: enumValuesOf(cap, f) }))
      .filter((e) => e.values.length > 0),
    dates: { ...cap.dates },
    ...(amount ? { amountField: amount.key } : {}),
    sortable: cap.fields.filter((f) => isQuerySortable(cap, f)).map(fieldWord),
    groupable: cap.fields.filter((f) => isQueryGroupable(cap, f)).map(fieldWord),
    states: { open: states.open, overdue: states.overdue, dueToday: states.dueToday, expiring: states.expiring },
    ...(states.expiring && qc?.expiring ? { expiring: { field: qc.expiring.field, running: qc.expiring.running } } : {}),
    q: !!qc?.q,
    dateFields: cap.fields
      .filter((f) => (f.kind === 'date' || f.kind === 'datetime') && conditionOpsFor(cap, f).includes('within'))
      .map((f) => f.key),
    defaultSort: { ...cap.sort.default },
    ...(currencyField && conditionOpsFor(cap, currencyField).includes('eq') ? { amountCurrencyField: currencyField.key } : {}),
  };
}

/** A Custom Module field's kind as the grammar's field words carry it. */
const CUSTOM_FIELD_KINDS: Readonly<Record<CustomFieldInfo['kind'], FieldKind>> = {
  text: 'text', number: 'number', date: 'date', datetime: 'datetime', enum: 'enum', multi: 'enum', boolean: 'boolean',
};

const customInfos = new WeakMap<CustomModuleInfo, GrammarModuleInfo>();

/** The grammar's view of one of the caller's Custom Modules (Increment 5),
 * from its current definition only (registry/custom-modules.ts): dropdown and
 * multi-select options as values, the fields executor M sorts and counts by,
 * and the dates a condition may use. A date written alone is the creation
 * date only where the module has no date field of its own ("site visits this
 * week": visited or created then?). No stages, states or amount. Pure; one
 * per entry (entries are frozen and cached, so the parser's caches hold). */
export function customGrammarModuleInfo(m: CustomModuleInfo): GrammarModuleInfo {
  const hit = customInfos.get(m);
  if (hit) return hit;
  const word = (f: CustomFieldInfo) => ({ key: f.key, label: f.label, kind: CUSTOM_FIELD_KINDS[f.kind] });
  const fields = [...m.fields, m.created];
  const dated = m.fields.filter((f) => f.kind === 'date' || f.kind === 'datetime');
  const info: GrammarModuleInfo = {
    key: m.key,
    stages: [],
    enums: m.fields
      .filter((f) => (f.kind === 'enum' || f.kind === 'multi') && f.ops.includes('eq') && !!f.options?.length)
      .map((f) => ({ field: f.key, values: [...(f.options ?? [])] })),
    dates: { default: dated.length ? '' : m.created.key, created: m.created.key },
    sortable: fields.filter((f) => f.sortable).map(word),
    groupable: fields.filter((f) => f.groupable).map(word),
    states: { open: false, overdue: false, dueToday: false, expiring: false },
    q: true,
    dateFields: [...dated, m.created].filter((f) => f.ops.includes('within')).map((f) => f.key),
    defaultSort: { by: m.created.key, dir: 'desc' },
    custom: m,
  };
  customInfos.set(m, info);
  return info;
}

/** The promise's value, or a rejection once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function stageWordsFor(tenantId: string, cap: ModuleCap): Promise<readonly StageWord[]> {
  const stage = cap.stage;
  if (!stage) return [];
  if (!('pipeline' in stage)) return schemaStageWords(cap);
  try {
    return await within(pipelineStageWords(tenantId, stage.pipeline), GRAMMAR_STAGE_WAIT.ms);
  } catch (err) {
    // No stage words: stage questions go to the existing assistant instead.
    logger.warn('CRM assistant grammar: stages unavailable', { module: cap.key, error: (err as Error)?.message });
    return [];
  }
}

/** The caller's Field Service currency, waiting as long as for stage words.
 * Later, or when it can't be read, null for this message: a currency written
 * next to a Field Service amount then goes to the existing assistant; the
 * read goes on and is cached for the next message. */
async function fsCurrencyFor(tenantId: string, branchId: string | null): Promise<string | null> {
  try {
    return await within(fsCurrencyOf(tenantId, branchId), GRAMMAR_STAGE_WAIT.ms);
  } catch (err) {
    logger.warn('CRM assistant grammar: Field Service currency unavailable', { error: (err as Error)?.message });
    return null;
  }
}

/** The grammar context for one caller: modules = the caller's capability
 * view (CapabilityView.modules), timezone = the tenant's, branchId = the
 * caller's branch (its Field Service currency), customModules = the Custom
 * Modules the caller may read (customModulesFor with access ok; none when
 * they couldn't be read). Never throws for a module it can't describe; that
 * module just gets no v1 words. */
export async function loadGrammarContext(input: {
  tenantId: string; timezone: string; modules: readonly ModuleCap[]; branchId?: string | null; now?: Date;
  /** The caller's Custom Modules, already gated by the caller (customModulesFor). */
  customModules?: readonly CustomModuleInfo[];
}): Promise<GrammarContext> {
  const now = input.now ?? new Date();
  const timezone = isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
  const infos = new Map<string, GrammarModuleInfo>();
  // Only Field Service amounts are in the caller's currency (a deal carries its
  // own). Read alongside the stage words; fsCurrencyFor never throws.
  const fsAmounts = input.modules.some((cap) => amountFieldOf(cap)?.money?.currency === 'fs_branch');
  const fsCurrency = fsAmounts ? fsCurrencyFor(input.tenantId, input.branchId ?? null) : Promise.resolve(null);
  await Promise.all(input.modules.map(async (cap) => {
    try {
      infos.set(cap.key, grammarModuleInfo(cap, await stageWordsFor(input.tenantId, cap)));
    } catch (err) {
      logger.warn('CRM assistant grammar: module left out', { module: cap.key, error: (err as Error)?.message });
    }
  }));
  return {
    ...grammarContextFromRegistry(),
    moduleInfo: (module) => (infos.has(module) ? infos.get(module) : undefined),
    todayKey: localDateKey(now, timezone),
    now,
    timezone,
    fsCurrency: await fsCurrency,
    ...(input.customModules?.length ? { customModules: input.customModules } : {}),
  };
}
