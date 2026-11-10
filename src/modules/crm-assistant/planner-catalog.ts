import type { CapabilityView } from './capability-view';
import type { GrammarContext, GrammarModuleInfo } from './grammar/context';
import type { FieldCap, FieldKind, ModuleCap, WriteFieldKind } from './registry/types';
import type { FillFormSpec } from './writes/workflow-types';
import { CustomFieldInfo, CustomModuleInfo, customFieldLetter } from './registry/custom-modules';
import { relationsFrom, relationsTo } from './registry/relations';
import { metricsFor } from './registry/metrics';
import {
  amountFieldOf, conditionOpsFor, isPiiField, isQueryGroupable, isQuerySortable, queryCapsFor,
} from './registry/query-caps';
import {
  PLANNER_CAPS, PLANNER_FIELD_KINDS, PLANNER_SOURCES, PlannerCatalog, PlannerCatalogSchema, estimateTokens,
} from './contracts/plan';
import { METRIC_PHRASES } from './grammar/vocabulary';
import { matchableText, plannerFillOf } from './planner-grounding';
import { localDateKey } from '../daily-events/daily-events.time';
import { isValidTimeZone } from '../native-crm/shared/date-range';
import { logger } from '../../utils/logger';

/* What the planner is told about the caller's CRM (plan 1.3 and 4.1): the
 * catalog sent with a message the grammar can't fully parse. Built only from
 * the caller's capability view (the registry modules they may read right
 * now) and the grammar context already loaded for them, so it never names a
 * module, field or stage they can't use. Pure: no database, no model call.
 *
 * Every module the caller may read is ranked by how the message points at it
 * (rankModules): a module the grammar saw +100, its name or a synonym in the
 * message +50, the last plan's module +30, the module on screen +20, one of
 * the tenant's stage labels in the message +20, one of its field labels +5;
 * ties in the usual order (customers, leads, work orders, invoices, deals,
 * tasks, then registry order). The first 12 are listed as [key, label,
 * source]; "more" counts the rest. The best 3 that scored get their fields
 * (only what executor Q can filter, sort or group by; never PII, hidden or
 * virtual fields, emails, phones or line items) with kind letters, the
 * tenant's stage labels and tagged outcomes; when nothing scored (a message
 * in another language names no module the ranking knows), the first 3
 * listed do. Fields come in the order the planner needs them (name, stage,
 * amount, main dates, owner, then the rest); a duration's label carries its
 * unit, and a field whose stored unit is uncertain is offered for sorting
 * only. Then the whole catalog is cut to PLANNER_CAPS (1,500 characters, 450
 * estimated tokens; a label's quote or backslash counted as the request
 * carries it, fits): stage lists to 8 first, then fields from the end of the
 * entry with the most field characters, keeping 6 per entry while another
 * has more, then whole entries once no entry has fields left, then modules.
 *
 * Increment 5: the Field Service documents (quotations, contracts, receipts)
 * come with the capability view like any module. A described module also
 * lists `rel`, the relations a plan may name on it (registry/relations.ts):
 * first the modules whose records refer to it ("has" / "has_none"), then the
 * ones it refers to ("for"), only those in the caller's view that executor Q
 * runs; and `metrics`, its named totals (registry/metrics.ts). A total named
 * in the message (its label, a synonym or the grammar's other words for it:
 * "outstanding", "owes", "payments received") names its module as the
 * module's own name does (+50), so the planner sees those totals. The caller's
 * Custom Modules (customModulesFor: access ok only) are listed too, as
 * [custom:<slug>, name, 'cm'], scored the same way (a module the grammar saw,
 * its name or singular name in the message, the last plan's, one of its
 * field labels) and placed after registry modules of the same score; a
 * described one lists the fields executor M can filter, sort or count by
 * (the record's name first, then the columns its page shows, the creation
 * date, then the rest), a relationship as "r" (it holds another record's
 * number, never a name). Custom Modules have no relations or totals.
 *
 * Increment 6: while a guided form is open in the chat (`form`, built from
 * the form's own fields by plannerFormOf), a typed answer the grammar can't
 * read comes here with that form. Its module is ranked first (with a seed's
 * score), its entry lists exactly the form's fields (at most 30, the record
 * fields as "r", which a fill names in refs) and the module's stages, and
 * `form` names the module. The caps are the same; when the size cuts leave
 * no entry for the form, no form is named either. */

export interface RankHints {
  /** Module keys the grammar saw in the message (already limited to the caller's view). */
  seeds?: readonly string[];
  /** The module of the session's last plan. */
  lastPlanModule?: string | null;
  /** The module of the record on screen. */
  focusModule?: string | null;
}

export interface RankedModule {
  cap: ModuleCap;
  score: number;
}

export interface PlannerCatalogInput {
  message: string;
  view: CapabilityView;
  grammar: GrammarContext;
  /** The tenant's timezone (an invalid one reads as UTC). */
  timezone: string;
  seeds?: { modules: readonly string[] };
  lastPlanModule?: string | null;
  focusModule?: string | null;
  now?: Date;
  /** The caller's Custom Modules, already gated by the caller (customModulesFor, Increment 5);
   * when absent, the grammar context's. `seeds` may name them by key ("custom:<slug>"). */
  customModules?: readonly CustomModuleInfo[];
  /** Increment 6: the guided form open in this chat (plannerFormOf), whose
   * module is ranked first and whose detail entry lists exactly these fields.
   * Left out when the caller can't read its module. */
  form?: { module: string; fields: Array<[key: string, kind: 'n' | 'm' | 'd' | 's' | 'e' | 'b' | 'r', label: string]> };
}

type CatalogField = PlannerCatalog['detail'][number]['f'][number];
type CatalogDetail = PlannerCatalog['detail'][number];
type FieldLetter = typeof PLANNER_FIELD_KINDS[number];
type SourceCode = typeof PLANNER_SOURCES[number];
type PlannerForm = NonNullable<PlannerCatalogInput['form']>;

const SCORES = { seed: 100, named: 50, lastPlan: 30, focus: 20, stage: 20, field: 5 } as const;
/** Ties keep this order, then registry order (as the help text picks its examples). */
const PREFERRED = ['customer', 'lead', 'workorder', 'invoice', 'deal', 'task'];

const MAX_MODULES = 12;
const MAX_DETAIL = 3;
const MAX_FIELDS = 30;
const MAX_STAGES = 20;
/** Stage lists are cut to this many when the catalog is over its cap. */
const TRIMMED_STAGES = 8;
/** Size cuts leave every entry this many fields while another entry has more. */
const FIELD_FLOOR = 6;
const MAX_OUTCOMES = 10;
/** The contract's limits on a detail entry's relation and metric names. */
const MAX_REL = 10;
const MAX_METRICS = 10;
/** An enum field with at most this many values lists them in its label. */
const MAX_LISTED_VALUES = 6;
const LABEL_MAX = 80;
const OUTCOME_MAX = 40;
const TZ_MAX = 64;
const CURRENCY_MAX = 8;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** The plan contract's field key (contracts/plan.ts FieldKeySchema). */
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/;

const KIND_LETTERS: Readonly<Record<FieldKind, FieldLetter | null>> = {
  number: 'n', percent: 'n', duration: 'n',
  money: 'm',
  date: 'd', datetime: 'd',
  text: 's', longtext: 's', id: 's',
  enum: 'e', stage: 'e',
  boolean: 'b',
  ref: 'r',
  ref_many: null, line_items: null, email: null, phone: null,
};

/** A guided form's fields by kind (spec B17): any record field is "r", which
 * a fill names in refs; an email or phone is text there, as typed. */
const WRITE_KIND_LETTERS: Readonly<Record<WriteFieldKind, FieldLetter>> = {
  text: 's', longtext: 's', email: 's', phone: 's',
  number: 'n', percent: 'n',
  money: 'm',
  date: 'd', datetime: 'd',
  enum: 'e', stage: 'e', multiselect: 'e',
  boolean: 'b',
  ref: 'r', ref_many: 'r', related: 'r', owner_user: 'r',
};

/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end).trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** The message's words with a space at each end, so a phrase is found as whole words. */
function wordsOf(message: string): string {
  return ` ${matchableText(message)} `;
}

function names(words: string, phrase: string): boolean {
  const p = matchableText(phrase);
  return !!p && words.includes(` ${p} `);
}

/** A condition may use the field: some operator is allowed and its stored
 * unit is known. A field whose unit is uncertain (FieldCap.unitUncertain: a
 * call's duration is minutes on the Calls screen, seconds elsewhere) can only
 * be sorted by (decision D-B; the plan validator refuses a condition on it). */
function filterable(cap: ModuleCap, field: FieldCap): boolean {
  return !field.unitUncertain && conditionOpsFor(cap, field).length > 0;
}

/** Fields the planner may use: what executor Q can filter, sort or group by,
 * never PII, hidden or virtual, and never emails, phones, lists or line items. */
function catalogFields(cap: ModuleCap): FieldCap[] {
  return cap.fields.filter((field) => KIND_LETTERS[field.kind] !== null
    && field.read !== 'hidden' && !field.virtual && !isPiiField(cap, field)
    && FIELD_KEY_RE.test(field.key) && field.key.length <= LABEL_MAX
    && (filterable(cap, field) || isQuerySortable(cap, field) || isQueryGroupable(cap, field)));
}

/** Fields in the order the planner needs them most, so the size cuts (which
 * drop an entry's last field) keep these longest: the record's name (the
 * first ids.title group; later groups are fallbacks), its stage, its amount,
 * its main dates (default, due, start, end, created) and its owner (the
 * "mine" rule's field); the rest keep registry order. */
function byUse(cap: ModuleCap, fields: readonly FieldCap[]): FieldCap[] {
  const first = [
    ...(cap.ids.title[0] ?? '').split(/\s+/),
    cap.stage?.field,
    amountFieldOf(cap)?.key,
    cap.dates.default, cap.dates.due, cap.dates.start, cap.dates.end, cap.dates.created,
    'field' in cap.mine ? cap.mine.field : undefined,
  ];
  const rank = (field: FieldCap): number => {
    const i = first.findIndex((key) => key === field.key || key === field.path);
    return i === -1 ? first.length : i;
  };
  return [...fields].sort((a, b) => rank(a) - rank(b));
}

/** The words that name the module's totals (registry/metrics.ts): each one's
 * label and synonyms, and the grammar's other words for it (METRIC_PHRASES:
 * "invoice total", "balance due", "owes"). The grammar leaves "top 5
 * customers by outstanding" and "who owes us the most" to the planner, which
 * can only name a total its module's catalog entry lists. */
function metricWords(module: string): string[] {
  return metricsFor(module).flatMap((metric) => [
    metric.label, ...metric.synonyms,
    ...METRIC_PHRASES.filter((phrase) => phrase.metric === metric.key).map((phrase) => phrase.words.join(' ')),
  ]);
}

function scoreOf(cap: ModuleCap, words: string, grammar: GrammarContext | null, hints: RankHints): number {
  let score = 0;
  if (hints.seeds?.includes(cap.key)) score += SCORES.seed;
  const named = [cap.labels.singular, cap.labels.plural, ...cap.labels.synonyms, ...metricWords(cap.key)];
  if (named.some((phrase) => names(words, phrase))) score += SCORES.named;
  if (hints.lastPlanModule === cap.key) score += SCORES.lastPlan;
  if (hints.focusModule === cap.key) score += SCORES.focus;
  const stages = grammar?.moduleInfo?.(cap.key)?.stages ?? [];
  if (stages.some((stage) => names(words, stage.label))) score += SCORES.stage;
  if (catalogFields(cap).some((field) => [field.label, ...(field.synonyms ?? [])].some((phrase) => names(words, phrase)))) {
    score += SCORES.field;
  }
  return score;
}

function preference(key: string): number {
  const i = PREFERRED.indexOf(key);
  return i === -1 ? PREFERRED.length : i;
}

/** Every module in the caller's view, best first (see above). `grammar` adds
 * the tenant's stage labels to the ranking; without it they don't count. */
export function rankModules(
  message: string, view: CapabilityView, grammar: GrammarContext | null, hints: RankHints = {},
): RankedModule[] {
  const words = wordsOf(message);
  return view.modules
    .map((cap, order) => ({ cap, score: scoreOf(cap, words, grammar, hints), order }))
    .sort((a, b) => (b.score - a.score) || (preference(a.cap.key) - preference(b.cap.key)) || (a.order - b.order))
    .map(({ cap, score }) => ({ cap, score }));
}

/** A Custom Module's fields a plan may use (executor M): those a condition,
 * the sort or a count can use (the module's entry already leaves out emails,
 * phones and what its tables don't show), the record's name first, then the
 * columns its page shows, the creation date and the rest. */
function customFields(info: CustomModuleInfo): CustomFieldInfo[] {
  return [...new Set([...info.titleFields, ...info.columns, info.created, ...info.fields])]
    .filter((field) => (field.ops.length > 0 || field.sortable || field.groupable)
      && FIELD_KEY_RE.test(field.key) && field.key.length <= LABEL_MAX);
}

/** Scored as a registry module is (scoreOf); a Custom Module has no stages. */
function customScoreOf(info: CustomModuleInfo, words: string, hints: RankHints): number {
  let score = 0;
  if (hints.seeds?.includes(info.key)) score += SCORES.seed;
  if ([info.name, info.singular].some((phrase) => names(words, phrase))) score += SCORES.named;
  if (hints.lastPlanModule === info.key) score += SCORES.lastPlan;
  if (hints.focusModule === info.key) score += SCORES.focus;
  if (customFields(info).some((field) => names(words, field.label))) score += SCORES.field;
  return score;
}

/** One module of the catalog (a registry module or a Custom Module), with
 * how it is listed and described. */
interface CatalogModule {
  key: string;
  label: string;
  source: SourceCode;
  score: number;
  detail(): CatalogDetail;
}

/** "<label> (<note>)" within the label limit: the label is cut, never the note. */
function noted(label: string, note: string): string {
  return `${clip(label, LABEL_MAX - note.length - 3)} (${note})`;
}

/** "Priority: low, medium, high": a choice with few values lists them, within the label limit. */
function withValues(label: string, values: readonly string[] | undefined): string {
  if (!values?.length || values.length > MAX_LISTED_VALUES) return label;
  const listed = `${label}: ${values.join(', ')}`;
  return listed.length <= LABEL_MAX ? listed : label;
}

/** "Priority: low, medium, high" for an enum with few values, within the
 * label limit; "Duration (hours)" for a duration in a known unit, so the
 * planner never compares minutes with hours; "Duration (sort only)" for a
 * field whose stored unit is uncertain (filterable). */
function fieldLabel(field: FieldCap, values: readonly string[] | undefined): string {
  const label = clip(field.label.trim() || field.key, LABEL_MAX);
  if (field.unitUncertain) return noted(label, 'sort only');
  if (field.kind === 'duration' && field.unit && !label.toLowerCase().includes(field.unit)) return noted(label, field.unit);
  return field.kind === 'enum' ? withValues(label, values) : label;
}

/** The relations a plan may name on this module (registry/relations.ts):
 * first the modules whose records refer to it ("has" / "has_none" name
 * them), then the ones it refers to ("for" names them); only modules in the
 * caller's view that executor Q runs (the validator refuses others, and
 * query/relations.ts reads the other side under its own gates). */
function relationNames(cap: ModuleCap, view: CapabilityView): string[] {
  return unique([...relationsFrom(cap.key).map((r) => r.child), ...relationsTo(cap.key).map((r) => r.parent)])
    .filter((module) => view.has(module) && !!queryCapsFor(module)?.q)
    .slice(0, MAX_REL);
}

/** The tenant's stage labels of the module, each once, within the limits. */
function stageLabelsOf(info: GrammarModuleInfo | undefined): string[] {
  return unique((info?.stages ?? []).map((s) => clip(s.label.trim(), LABEL_MAX)).filter(Boolean)).slice(0, MAX_STAGES);
}

function detailOf(cap: ModuleCap, grammar: GrammarContext, view: CapabilityView): CatalogDetail {
  const info = grammar.moduleInfo?.(cap.key);
  const enumValues = new Map((info?.enums ?? []).map((e) => [e.field, e.values]));
  // A module executor Q can't run is listed and counted as it is: no field,
  // relation or total can be used.
  const q = !!queryCapsFor(cap.key)?.q;
  const fields: CatalogField[] = q
    ? byUse(cap, catalogFields(cap)).slice(0, MAX_FIELDS)
      .map((field) => [field.key, KIND_LETTERS[field.kind] as FieldLetter, fieldLabel(field, enumValues.get(field.key))])
    : [];
  const stageWords = info?.stages ?? [];
  const stages = stageLabelsOf(info);
  const outcomes = unique(stageWords
    .map((s) => (typeof s.outcome === 'string' ? clip(s.outcome.trim(), OUTCOME_MAX) : ''))
    .filter(Boolean)).slice(0, MAX_OUTCOMES);
  const rel = q ? relationNames(cap, view) : [];
  const metrics = q ? metricsFor(cap.key).map((m) => m.key).slice(0, MAX_METRICS) : [];
  return {
    m: cap.key, f: fields,
    ...(stages.length ? { stages } : {}), ...(outcomes.length ? { outcomes } : {}),
    ...(rel.length ? { rel } : {}), ...(metrics.length ? { metrics } : {}),
  };
}

/** A Custom Module's entry (customFields). A relationship is "r": it holds
 * another record's number (or id), never a name. */
function customDetailOf(info: CustomModuleInfo): CatalogDetail {
  const fields: CatalogField[] = customFields(info).slice(0, MAX_FIELDS).map((field) => {
    const label = clip(field.label.trim() || field.fieldKey, LABEL_MAX);
    const choice = field.kind === 'enum' || field.kind === 'multi';
    return [field.key, field.fieldType === 'relationship' ? 'r' : customFieldLetter(field), choice ? withValues(label, field.options) : label];
  });
  return { m: info.key, f: fields };
}

/** Increment 6: the catalog's `form` for the guided form open in this chat,
 * from its fields (formSpecFor), in the form's order: the ones the planner
 * may answer (planner-grounding.ts plannerFillOf), as [key, letter, label].
 * Values fill the fields it may fill; refs name the records of the "r"
 * fields. A field the form keeps from the planner (a work order's address)
 * is not offered. */
export function plannerFormOf(spec: FillFormSpec): PlannerForm {
  return {
    module: spec.module,
    fields: spec.fields
      .filter((field) => plannerFillOf(spec.module, field) !== null)
      .map((field): [string, FieldLetter, string] => [field.key, WRITE_KIND_LETTERS[field.kind], field.label]),
  };
}

/** The open form (input.form) as the catalog lists it: only when the caller
 * may read its module; at most 30 fields, each a key and letter the contract
 * takes, once, its label within the label limit. */
function formOf(input: PlannerCatalogInput): { module: string; fields: CatalogField[] } | null {
  const form = input.form;
  if (!form || !input.view.modules.some((cap) => cap.key === form.module)) return null;
  const keys = new Set<string>();
  const fields: CatalogField[] = [];
  for (const [key, letter, label] of form.fields) {
    if (fields.length === MAX_FIELDS) break;
    if (!FIELD_KEY_RE.test(key) || key.length > LABEL_MAX || keys.has(key) || !PLANNER_FIELD_KINDS.includes(letter)) continue;
    keys.add(key);
    fields.push([key, letter, clip(label.trim() || key, LABEL_MAX)]);
  }
  return { module: form.module, fields };
}

/** The open form's entry: exactly its fields (a choice with few values lists
 * them, as in any entry) and the module's stages. */
function formDetailOf(module: string, fields: readonly CatalogField[], grammar: GrammarContext): CatalogDetail {
  const info = grammar.moduleInfo?.(module);
  const enumValues = new Map((info?.enums ?? []).map((e) => [e.field, e.values]));
  const stages = stageLabelsOf(info);
  return {
    m: module,
    f: fields.map(([key, letter, label]): CatalogField => [key, letter, letter === 'e' ? withValues(label, enumValues.get(key)) : label]),
    ...(stages.length ? { stages } : {}),
  };
}

function sourceOf(cap: ModuleCap): SourceCode {
  return cap.group === 'native_crm' ? 'crm' : 'fs';
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Within the caps as the planner's request carries the catalog: its JSON
 * goes inside the user message, whose own JSON escapes every quote and
 * backslash once more. A quote, backslash or control character in a tenant's
 * label is escaped in the catalog's JSON already (a backslash each) and costs
 * two characters more in the request, so each backslash counts three times
 * here; the request's worst case (the AI service's
 * verify-crm-assist-planner.ts) allows for the catalog's own quotes. The
 * labels keep them: the planner copies stage labels and choices exactly. */
function fits(catalog: PlannerCatalog): boolean {
  const text = JSON.stringify(catalog);
  const escapes = 2 * (text.match(/\\/g) ?? []).length;
  return text.length + escapes <= PLANNER_CAPS.catalogChars
    && estimateTokens(text) + Math.ceil(escapes / 4) <= PLANNER_CAPS.catalogEstTokens;
}

/** Of the entries with more than `floor` fields, the one whose fields take
 * the most characters (the lower-ranked one of equals); its stage list
 * doesn't count, so a long pipeline never costs its own entry every field. */
function widestFields(catalog: PlannerCatalog, floor: number): CatalogDetail | undefined {
  let widest: CatalogDetail | undefined;
  for (const entry of catalog.detail) {
    if (entry.f.length > floor && (!widest || sizeOf(entry.f) >= sizeOf(widest.f))) widest = entry;
  }
  return widest;
}

/** One cut toward the size cap, in order: stage lists to 8; the last field of
 * the entry with the widest fields among those above FIELD_FLOOR fields, then
 * among those with any (fields are ordered by use: byUse); the last detail
 * entry once no entry has a field; the last module (counted in "more"). False
 * when nothing is left to cut. */
function cutOnce(catalog: PlannerCatalog): boolean {
  const long = catalog.detail.filter((entry) => (entry.stages?.length ?? 0) > TRIMMED_STAGES);
  if (long.length) {
    for (const entry of long) entry.stages = entry.stages!.slice(0, TRIMMED_STAGES);
    return true;
  }
  const entry = widestFields(catalog, FIELD_FLOOR) ?? widestFields(catalog, 0);
  if (entry) { entry.f.pop(); return true; }
  if (catalog.detail.length) { catalog.detail.pop(); return true; }
  if (catalog.modules.length) { catalog.modules.pop(); catalog.more += 1; return true; }
  return false;
}

/** The registry modules of the caller's view (rankModules) and their Custom
 * Modules (in definition order on equal scores), best first; a Custom Module
 * comes after the registry modules of its score. The open form's module
 * (formOf) comes first of all and is described by the form's fields. */
function rankCatalog(input: PlannerCatalogInput, hints: RankHints, form: ReturnType<typeof formOf>): CatalogModule[] {
  const registry = rankModules(input.message, input.view, input.grammar, hints).map(({ cap, score }): CatalogModule => ({
    key: cap.key, label: cap.labels.plural, source: sourceOf(cap), score,
    detail: () => (form?.module === cap.key ? formDetailOf(cap.key, form.fields, input.grammar) : detailOf(cap, input.grammar, input.view)),
  }));
  const words = wordsOf(input.message);
  const custom = (input.customModules ?? input.grammar.customModules ?? []).map((info): CatalogModule => ({
    key: info.key, label: info.name, source: 'cm', score: customScoreOf(info, words, hints), detail: () => customDetailOf(info),
  }));
  const ranked = [...registry, ...custom]
    .map((module, order) => ({ module, order }))
    .sort((a, b) => (b.module.score - a.module.score) || (a.order - b.order))
    .map(({ module }) => module);
  const at = form ? ranked.findIndex((module) => module.key === form.module) : -1;
  return at > 0 ? [ranked[at], ...ranked.slice(0, at), ...ranked.slice(at + 1)] : ranked;
}

/** The catalog for one planner call (see above). Always within PLANNER_CAPS
 * and valid against PlannerCatalogSchema. */
export function buildPlannerCatalog(input: PlannerCatalogInput): PlannerCatalog {
  const timezone = isValidTimeZone(input.timezone) && input.timezone.length <= TZ_MAX ? input.timezone : 'UTC';
  const todayKey = input.grammar.todayKey;
  const today = todayKey && DAY_KEY.test(todayKey) ? todayKey : localDateKey(input.now ?? new Date(), timezone);
  const fsCurrency = input.grammar.fsCurrency;
  const currency = typeof fsCurrency === 'string' && fsCurrency && fsCurrency.length <= CURRENCY_MAX ? fsCurrency : null;

  // The open form's module scores as a module the grammar saw (spec B17).
  const form = formOf(input);
  const ranked = rankCatalog(input, {
    seeds: [...(input.seeds?.modules ?? []), ...(form ? [form.module] : [])],
    lastPlanModule: input.lastPlanModule ?? null,
    focusModule: input.focusModule ?? null,
  }, form);
  const listed = ranked.slice(0, MAX_MODULES);
  // The last plan's and the focus module score on their own, so a module the
  // message points at, or the one the conversation is about, is described.
  // When nothing scored (a message in another language, which the ranking
  // can't read, decision D17), the first modules listed are, so the planner
  // still sees field keys; the size cuts trim them.
  const scored = listed.filter((r) => r.score > 0);
  const described = (scored.length ? scored : listed).slice(0, MAX_DETAIL);
  const catalog: PlannerCatalog = {
    today,
    tz: timezone,
    currency,
    modules: listed.map((module) => [module.key, clip(module.label, LABEL_MAX), module.source]),
    more: ranked.length - listed.length,
    ...(form ? { form: form.module } : {}),
    detail: described.map((module) => module.detail()),
  };
  while (!fits(catalog) && cutOnce(catalog)) { /* cut until it fits */ }
  // Labels too long to fit even cut can take the form's entry: then the
  // catalog names no form either.
  if (catalog.form && !catalog.detail.some((entry) => entry.m === catalog.form)) delete catalog.form;

  const checked = PlannerCatalogSchema.safeParse(catalog);
  if (checked.success) return checked.data;
  // Not expected (every part is built within the schema's limits): fail
  // closed to the bare catalog, which always fits.
  logger.warn('CRM assist: planner catalog failed its schema; modules left out', {
    issues: checked.error.issues.slice(0, 3).map((i) => i.path.join('.')),
  });
  return { today, tz: timezone, currency, modules: [], more: ranked.length, detail: [] };
}
