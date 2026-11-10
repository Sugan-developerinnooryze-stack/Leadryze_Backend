import { QueryPlanSchema } from '../contracts/plan';
import type { Cond, QueryPlan, RelRange, SourceKey } from '../contracts/plan';
import type { LegacyReason } from '../contracts/api';
import type { FieldKind } from '../registry/types';
import type { CustomModuleInfo } from '../registry/custom-modules';
import { defaultParentFor, relationFor, relationsTo } from '../registry/relations';
import { METRICS, MetricDef, metricFor, metricsFor } from '../registry/metrics';
import {
  BUSINESS_NUMBER_MODULES, CONFIG_NOUNS, COUNT_PHRASES, COUNT_WORDS, CREATE_VERBS, FAREWELLS, FILLERS, FILTER_WORDS,
  GREETINGS, GREETING_EXTRAS, HELP_PHRASES, HELP_WORD, LIST_VERBS, NATIVE_SMALL_TALK, POLITE_PREFIX, SOURCE_PHRASES,
  THANKS_WORDS, Token, TokenSpan, UPDATE_VERBS, WRITE_VERBS, WordToken, phraseWords, phraseWordsV1, quotedSpans, tokenize,
  tokenizeV1, tokenizeV1Spans,
} from './tokens';
import { customGrammarModuleInfo } from './context';
import type { GrammarContext, GrammarModuleInfo, StageWord } from './context';
import {
  AGENDA_GAP_WORDS, AGENDA_LEADS, AMOUNT_COMPARATORS, AMOUNT_FIELD_WORDS, AMOUNT_LEADS, AMOUNT_OPEN_ENDS, AND_WORD, AS_WORD, AmountOp,
  BARE_PIPELINE_WORDS, BREAKDOWN_PHRASES, BUCKET_ADJECTIVES, BUCKET_WORDS, BY_WORD, Bucket, CONNECTOR_CONCEPT_WORDS, CONNECTOR_PHRASES,
  CREATED_FIELD_WORDS, CUSTOMER_CONCEPT_WORDS,
  ConnectorType, DATE_FIELD_WORDS, DATE_PREFIXES, DONE_WORDS, DRAFT_DOCUMENTS, DRAFT_STAGE_AFTER, DRAFT_WORD, DateSel, EACH_WORD,
  ENUM_FIELDS_NOT_WORDS, EXCLUDED_CONNECTOR_MODULES, EXPIRING_PHRASES, EXPIRING_WINDOWS, FOCUS_WORDS, FOR_WORDS, GET_WORD,
  GROUP_BY_PHRASES, HAS_PHRASES, HOW_MUCH, HasKind,
  I_FOLLOWERS, I_SEE_VERBS, I_WANT_WORDS, I_WORD, MAX_GRAMMAR_WORDS, MAX_NAME_WORDS, METRIC_BARE_DATES, METRIC_GROUP_FIELDS, METRIC_GROUP_FIRST,
  METRIC_GROUP_INTROS, METRIC_GROUP_TAIL, METRIC_PHRASES, METRIC_RANK_WORDS, NAMED_WORDS, NAME_ARTICLES, NAME_CURRENCY_CODES,
  NAME_END_WORDS, NAME_FIELD_NOUNS, NAME_NEGATION_WORDS, NAME_PURPOSE_WORDS, NAME_STOP_WORDS, NAME_TIME_PATTERN, NAME_TIME_WORDS,
  OPEN_WORD, PENDING_APPROVAL, PIPELINE_MODULES, PIPELINE_WORDS, PRESENT_PHRASES, PresentWord, SALES_PIPELINE,
  SEARCH_PHRASES, MAX_STORED_MODULE_NAME, MINE_EVENT_VERBS, MINE_PHRASES, MONTH_NAMES, MineMode, MinePhrase, MinePlace, NUMBER_WORDS,
  OF_WORD, ORDINAL_SUFFIXES, OR_WORD, OTHER_THAN, OUTCOME_WORDS, SORT_BY_PHRASES,
  SORT_DIRECTIONS, SORT_WORDS, SORT_WORD_TAIL, STAGE_FIELD_WORDS, STAGE_TAILS, STATE_PHRASES,
  STORED_MODULE_NAME_RE, STORED_MODULE_NOUNS, STORED_MODULE_STOP_WORDS, StateWord, TOP_WORD, TOTAL_WORD, TO_DO_WORDS, V1_FILLERS,
  V1_FILLER_PHRASES, V1_NOT_FILLERS, VAGUE_VALUE_WORDS, VALUE_ALIASES, VENDOR_DETERMINERS, VENDOR_MENTION_WORDS,
} from './vocabulary';
import { DateValue, allowsNoPastDay, matchDateExpr, relRangeAt } from './dates';
import { matchMoney, roundAmount } from './numbers';
import { parseAgenda } from './agenda';

/* Grammar v0 (Increment 1): show / list / find / count one module, open a
 * record by its business number, greetings and help (since Increment 4 also
 * goodbyes, closers like "no thanks", and greetings and thanks in Hindi and
 * Tamil script: parseSmallTalk, which parseMessage asks first). A read is
 * accepted only when every word is used, exactly one module is named and
 * nothing conflicts; anything else goes back to the existing assistant with
 * a reason. Write and configuration wording is recognised so it is never
 * answered here. Pure: no database, no registry access beyond `ctx` (and the
 * fixed tables of registry/relations.ts and registry/metrics.ts).
 *
 * Grammar v1 (Increment 3), only with a v1 context (loadGrammarContext,
 * context.ts): reads of one module with states, stages, enum values, dates
 * and amounts, sort and top N, "count by <field>" breakdowns, the customer
 * concept count and connector counts; since Increment 4 also the caller's
 * own records ("mine"). It runs only where v0 hands the message on
 * (needs_planner), so everything v0 answers is answered the same way, except
 * a plain v0 read that v1 narrows (see parseMessage). See parseV1 below.
 *
 * Increment 5 adds the documents' words (quotations "pending approval",
 * contracts and quotations "expiring"), relations ("customers with no
 * invoices", "work orders for ABC Industries", "invoices for this work
 * order"), named metrics ("invoice totals per customer", "payments received
 * this month", "top 5 customers by outstanding") and the caller's Custom
 * Modules (their names, values, dates and a text search), with a word that
 * names both a built-in module and a Custom Module offered as a choice (kind
 * 'ambiguous_module'). See readTarget.
 *
 * Increment 8 adds how a read is drawn ("as a chart", "line chart of ...",
 * "as a table": plan.present), bucket adjectives ("monthly work orders"),
 * named totals by date ("payments received per month"), the deal totals
 * ("pipeline value by stage", "won value this quarter"), pipeline words ("deal
 * pipeline", "sales funnel"; bare "pipeline" asks which one: barePipeline)
 * and, with no module named, the agenda ("what's on this week": agenda.ts). */

export type { GrammarContext, GrammarModuleInfo, StageWord } from './context';
export { grammarContextFromRegistry } from './context';
export type { ConnectorType } from './vocabulary';

interface ParseBase { modules: string[]; filterKeys: string[] }
export type GrammarParse =
  | (ParseBase & { kind: 'greeting'; op: 'greeting'; variant: 'hello' | 'thanks' | 'bye' })
  | (ParseBase & { kind: 'help'; op: 'help' })
  | (ParseBase & { kind: 'read'; op: 'list' | 'count' | 'aggregate'; module: string; source?: SourceKey; plan: QueryPlan })
  | (ParseBase & { kind: 'detail'; op: 'detail'; module: string; number: string; plan: QueryPlan })
  /** plan.target = { concept: 'customer' }: one count per source, never summed. */
  | (ParseBase & { kind: 'concept_count'; op: 'count'; concept: 'customer'; plan: QueryPlan })
  | (ParseBase & {
      kind: 'connector_count'; op: 'count'; connector: ConnectorType;
      target: { concept: 'deal' | 'customer' } | { storedModule: string };
    })
  /** An agenda across modules ("what's on this week", Increment 8): plan { op 'agenda', target { concept 'agenda' } }. */
  | (ParseBase & { kind: 'agenda'; op: 'agenda'; plan: QueryPlan })
  /** A module word that names both a built-in module and one of the tenant's
   * Custom Modules ("equipment"): the same read for each candidate, offered
   * as choices (Increment 5). */
  | (ParseBase & {
      kind: 'ambiguous_module'; op: 'list' | 'count' | 'aggregate'; candidates: string[]; plans: QueryPlan[];
      /** 'pipeline': bare "pipeline", a choice of the caller's pipelines (Increment 8). */
      question?: 'pipeline';
    })
  | (ParseBase & { kind: 'legacy'; reason: LegacyReason; op?: string });

type SmallTalk = Extract<GrammarParse, { kind: 'greeting' | 'help' }>;
type GreetingVariant = Extract<GrammarParse, { kind: 'greeting' }>['variant'];

/** A greeting, thanks, goodbye or a request for help, and nothing else in the
 * message: answered without an AI call in any assistant language (resolve
 * asks this first for a tenant whose assistant language isn't English, whose
 * messages are otherwise never parsed, decision D17; parseMessage asks it
 * first too). The words as typed ("hi", "thanks a lot", "no thanks", "ok
 * bye", "good night", "help", "who are you"; smallTalkOf), or a whole message
 * in Hindi or Tamil script ("नमस्ते", "நன்றி"; NATIVE_SMALL_TALK). null for
 * anything else. */
export function parseSmallTalk(message: string, ctx: GrammarContext): Extract<GrammarParse, { kind: 'greeting' | 'help' }> | null {
  const text = typeof message === 'string' ? message : '';
  const native = NATIVE_SMALL_TALK.get(text.normalize('NFC').replace(END_NOISE, ''));
  if (native) return greeting(native);
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > MAX_GRAMMAR_WORDS) return null;
  return smallTalkOf(segment(tokens, phrasesFor(ctx)));
}

/** Longer messages are never short commands (vocabulary.ts, so agenda.ts reads it too). */
export { MAX_GRAMMAR_WORDS };

/** Allowed next to a business number only. "my" too: the number names one
 * record, which the caller's scope lets them see or not, so "show my work
 * order <number>" is that record ("is <number> mine?" is a question for the
 * planner). */
const DETAIL_WORDS: ReadonlySet<string> = new Set(['open', 'check', 'look', 'number', 'id', 'no', 'my']);

type Item =
  | { t: 'word'; w: string }
  | { t: 'number'; number: string; code: string }
  | { t: 'module'; key: string }
  | { t: 'source'; source: 'native_crm' | 'field_service' }
  | { t: 'count' }
  | { t: 'greeting'; variant: GreetingVariant };

interface Phrase { words: string[]; item: Item; priority: number }

const GREETING_PHRASES: ReadonlyArray<{ words: string[]; variant: GreetingVariant }> = [
  { words: ['good', 'morning'], variant: 'hello' },
  { words: ['good', 'afternoon'], variant: 'hello' },
  { words: ['good', 'evening'], variant: 'hello' },
  { words: ['good', 'night'], variant: 'bye' },
  { words: ['thank', 'you'], variant: 'thanks' },
];

const phraseCache = new WeakMap<object, Phrase[]>();

function phrasesFor(ctx: GrammarContext): Phrase[] {
  const cached = phraseCache.get(ctx.synonyms);
  if (cached) return cached;
  const phrases: Phrase[] = [
    ...SOURCE_PHRASES.map((s) => ({ words: s.words, item: { t: 'source', source: s.source } as Item, priority: 4 })),
    ...COUNT_PHRASES.map((words) => ({ words, item: { t: 'count' } as Item, priority: 3 })),
    ...GREETING_PHRASES.map((g) => ({ words: g.words, item: { t: 'greeting', variant: g.variant } as Item, priority: 2 })),
    ...ctx.synonyms
      .map((s) => ({ words: phraseWords(s.phrase), item: { t: 'module', key: s.key } as Item, priority: 1 }))
      .filter((p) => p.words.length > 0),
  ];
  phrases.sort((a, b) => b.words.length - a.words.length || b.priority - a.priority);
  phraseCache.set(ctx.synonyms, phrases);
  return phrases;
}

/** Longest phrase first at every position; business numbers are their own items. */
function segment(tokens: Token[], phrases: Phrase[]): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind === 'number') { items.push({ t: 'number', number: tok.number, code: tok.code }); i += 1; continue; }
    const hit = phrases.find((p) => p.words.every((w, k) => {
      const t = tokens[i + k];
      return t !== undefined && t.kind === 'word' && t.w === w;
    }));
    if (hit) { items.push(hit.item); i += hit.words.length; continue; }
    items.push({ t: 'word', w: tok.w });
    i += 1;
  }
  return items;
}

const uniq = <T>(values: T[]): T[] => [...new Set(values)];

function wordsOf(items: Item[]): string[] {
  return items.flatMap((it) => (it.t === 'word' ? [it.w] : []));
}

/** Filter keys for words grammar v0 doesn't use: keys only, never values. */
function filterKeysFor(unused: string[]): string[] {
  const keys = unused.map((w) => FILTER_WORDS[w] ?? (/^\p{N}+$/u.test(w) ? 'amount' : 'search'));
  return uniq(keys).sort();
}

function legacy(reason: LegacyReason, modules: string[], filterKeys: string[], op?: string): GrammarParse {
  return { kind: 'legacy', reason, modules, filterKeys, ...(op ? { op } : {}) };
}

function isReadVerbItem(it: Item): boolean {
  return it.t === 'count' || (it.t === 'word' && (LIST_VERBS.has(it.w) || COUNT_WORDS.has(it.w)));
}

function isPoliteItem(it: Item): boolean {
  return it.t === 'greeting' || (it.t === 'word' && POLITE_PREFIX.has(it.w));
}

/** Words allowed around a read without changing it. */
function isReadFiller(w: string): boolean {
  return FILLERS.has(w) || GREETINGS.has(w) || w === HELP_WORD || LIST_VERBS.has(w) || COUNT_WORDS.has(w);
}

/** Punctuation, symbols and emoji at either end of a message ("नमस्ते 🙏",
 * "धन्यवाद!", "நன்றி."). Never combining marks: Indic words end in them. */
const END_NOISE = /^[\s\p{P}\p{S}\p{Join_Control}\p{Variation_Selector}]+|[\s\p{P}\p{S}\p{Join_Control}\p{Variation_Selector}]+$/gu;

const greeting = (variant: GreetingVariant): SmallTalk => ({ kind: 'greeting', op: 'greeting', variant, modules: [], filterKeys: [] });

/** What a word says as small talk: thanks, goodbye, a greeting, or nothing. */
function greetingOf(w: string): GreetingVariant | null {
  if (THANKS_WORDS.has(w)) return 'thanks';
  if (FAREWELLS.has(w)) return 'bye';
  return GREETINGS.has(w) ? 'hello' : null;
}

/** The whole message's items as small talk: a help question (HELP_PHRASES,
 * or "help" among fillers and greetings), or greeting, thanks and goodbye
 * words with nothing but GREETING_EXTRAS and fillers around them. Thanks wins
 * over goodbye and goodbye over hello ("thanks, bye" is thanks). A bare "ok",
 * "cool", "yes" or "no" is not small talk: it may answer the existing
 * assistant's own question. null for anything else. */
function smallTalkOf(items: readonly Item[]): SmallTalk | null {
  if (!items.every((it) => it.t === 'word' || it.t === 'greeting')) return null;
  const plain = items.flatMap((it) => (it.t === 'word' ? [it.w] : []));
  const leadingTrimmed = [...plain];
  while (leadingTrimmed.length && (GREETINGS.has(leadingTrimmed[0]) || leadingTrimmed[0] === 'please')) leadingTrimmed.shift();
  if ((leadingTrimmed.length > 0 && HELP_PHRASES.has(leadingTrimmed.join(' ')))
    || (plain.includes(HELP_WORD) && plain.every((w) => w === HELP_WORD || FILLERS.has(w) || GREETINGS.has(w) || POLITE_PREFIX.has(w)))) {
    return { kind: 'help', op: 'help', modules: [], filterKeys: [] };
  }
  const said = items.flatMap((it) => {
    const variant = it.t === 'greeting' ? it.variant : it.t === 'word' ? greetingOf(it.w) : null;
    return variant ? [variant] : [];
  });
  if (!said.length || !plain.every((w) => greetingOf(w) !== null || GREETING_EXTRAS.has(w) || FILLERS.has(w))) return null;
  return greeting(said.includes('thanks') ? 'thanks' : said.includes('bye') ? 'bye' : 'hello');
}

/** Grammar v0, exactly as Increment 1 shipped it, except its greetings and
 * help, which parseSmallTalk reads before it (parseMessage). */
function parseV0(message: string, ctx: GrammarContext): GrammarParse {
  const tokens = tokenize(typeof message === 'string' ? message : '');
  if (tokens.length === 0 || tokens.length > MAX_GRAMMAR_WORDS) return legacy('needs_planner', [], []);

  const items = segment(tokens, phrasesFor(ctx));
  const words = wordsOf(items);
  const numbers = items.flatMap((it) => (it.t === 'number' ? [it] : []));
  const moduleKeys = uniq(items.flatMap((it) => (it.t === 'module' ? [it.key] : [])));
  const numberModules = numbers.map((n) => BUSINESS_NUMBER_MODULES[n.code]).filter((m): m is string => !!m);
  const mentioned = uniq([...moduleKeys, ...numberModules]);
  const sources = uniq(items.flatMap((it) => (it.t === 'source' ? [it.source] : [])));

  /* Write and configuration wording: a write verb at the start (or after a
   * polite prefix), or anywhere when the message doesn't start as a read. */
  const firstMeaningful = items.find((it) => !isPoliteItem(it));
  const startsWithWrite = firstMeaningful?.t === 'word' && WRITE_VERBS.has(firstMeaningful.w);
  const startsWithRead = !!firstMeaningful && isReadVerbItem(firstMeaningful);
  const writeVerb = words.find((w) => WRITE_VERBS.has(w));
  if (writeVerb && (startsWithWrite || !startsWithRead)) {
    const verb = startsWithWrite && firstMeaningful?.t === 'word' ? firstMeaningful.w : writeVerb;
    const op = CREATE_VERBS.has(verb) ? 'create' : UPDATE_VERBS.has(verb) ? 'update' : 'delete';
    const unused = words.filter((w) => !WRITE_VERBS.has(w) && !isReadFiller(w) && !POLITE_PREFIX.has(w) && !CONFIG_NOUNS.has(w));
    if (words.some((w) => CONFIG_NOUNS.has(w))) return legacy('config', mentioned, filterKeysFor(unused), 'config');
    return legacy('write', mentioned, filterKeysFor(unused), op);
  }

  const unused = words.filter((w) => !isReadFiller(w));
  const filterKeys = filterKeysFor(unused);

  /* A read: one module (or one business number), every word used. */
  if (moduleKeys.length > 0 || numbers.length > 0) {
    if (numbers.length > 1) return legacy('needs_planner', mentioned, filterKeys);
    const hasCount = items.some((it) => it.t === 'count' || (it.t === 'word' && COUNT_WORDS.has(it.w)));
    const hasList = words.some((w) => LIST_VERBS.has(w));

    if (numbers.length === 1) {
      // "open work order number 9A218C-WO-0001": these words only name the record.
      if (unused.some((w) => !DETAIL_WORDS.has(w))) return legacy('needs_planner', mentioned, filterKeys);
      const { number, code } = numbers[0];
      const module = BUSINESS_NUMBER_MODULES[code];
      if (!module || hasCount || moduleKeys.some((k) => k !== module)) return legacy('needs_planner', mentioned, filterKeys);
      const group = ctx.groupOf(module);
      if (!group) return legacy('unsupported', mentioned, filterKeys);
      if (sources.some((s) => s !== group)) return legacy('needs_planner', mentioned, filterKeys);
      return {
        kind: 'detail', op: 'detail', module, number, modules: [module], filterKeys: [],
        plan: { v: 1, op: 'detail', target: { module }, record: { number } },
      };
    }

    if (unused.length > 0 || moduleKeys.length !== 1) return legacy('needs_planner', mentioned, filterKeys);
    const module = moduleKeys[0];
    const op = hasCount ? 'count' : hasList ? 'list' : null;
    // A bare module name ("customers") may be a reply to the existing
    // assistant's own question, so it is not answered here.
    if (!op) return legacy('needs_planner', mentioned, filterKeys);
    const group = ctx.groupOf(module);
    if (!group) return legacy('unsupported', mentioned, filterKeys);
    if (sources.length > 1 || (sources.length === 1 && sources[0] !== group)) return legacy('needs_planner', mentioned, filterKeys);
    return {
      kind: 'read', op, module, modules: [module], filterKeys: [],
      ...(sources.length === 1 ? { source: sources[0] } : {}),
      plan: { v: 1, op, target: { module } },
    };
  }

  return legacy('needs_planner', mentioned, filterKeys);
}

/* ── Grammar v1 (Increment 3) ──────────────────────────────────────────────
 *
 * Reads of one module with filters (state, stage, outcome, enum values,
 * dates, amounts), sort and top N, "count by <field>" breakdowns, the
 * customer concept count and connector counts, with 0 LLM calls. Rules
 * (plan 4.2):
 *  - whole lower-cased words only, and every word is used (fillers aside);
 *  - exactly one module, concept or vendor. A second module, relations
 *    ("with", "without", "no", "for <X>"), sums and averages, two readings
 *    that both work, and anything else unsure go to needs_planner: a
 *    hand-off is better than a wrong answer;
 *  - "mine" (Increment 4, MINE_PHRASES): "my leads", "deals assigned to
 *    me", "how many deals do I have" (plan.mine 'assigned'), "leads I
 *    created", "tickets raised by me" ('created'), each only where it names
 *    the module's records (mineOf), and only for modules executor Q runs.
 *    Never "my team's", "my company", "we", "our", "us", "unassigned" or
 *    "assigned to <name>";
 *  - the module's own words (its tenant stage labels and keys, enum values,
 *    field labels, dates, amount) come from GrammarModuleInfo, built from the
 *    same registry rules the plan validator uses, so a plan only names
 *    fields, operators, sorts and groups the validator accepts;
 *  - the message is read once per module it names, with that module's words,
 *    and exactly one reading must use every word: "customer contacts" are
 *    contacts whose status is customer, "meeting scheduled leads" are leads
 *    in the Meeting Scheduled stage, "call activities" are activities of type
 *    call;
 *  - what could be read two ways is not read: "or" between anything but two
 *    values of one field, a finished state with the record's own date ("deals
 *    won last month", "won deals per month", "latest won deals"; calls and
 *    meetings, whose date is the call or meeting itself, aside), a vague value
 *    on its own ("show other leads"), a currency next to a Field Service
 *    amount other than the caller's (GrammarContext.fsCurrency), an unknown
 *    currency symbol, a negative number, "by <text field>" (a sort or a
 *    breakdown?);
 *  - what would be the opposite set or no set at all is not read either: a
 *    stage after "to be" or "to get" ("invoices to be paid" are unpaid), an
 *    open state with a finished stage ("open and won deals", also among other
 *    stages: "open, contacted and won leads"), "overdue" with a due date
 *    from today on ("overdue invoices next week"), a sum ("expenses total"),
 *    the caller's own work ("what do I need to do today", "deals I have to
 *    close"), an agenda question ("what do we need to do today");
 *  - those refusals are deliberate (REFUSED): parseMessage then hands the
 *    message on even where grammar v0 would read it plainly ("show tasks I
 *    need to do" is not every task). A sum is the exception: grammar v0 has
 *    counted a plain "<module> total" since Increment 1, except "invoice
 *    total", the purchase amount since the Increment 5 review (decision D5). */

type Sel = DateSel | 'default';
type SortTarget = { kind: 'created' } | { kind: 'amount' } | { kind: 'field'; key: string };

/* count, list and filler items keep the single word they were read from (w). */
type V1Item =
  | { t: 'module'; key: string; words: readonly string[] }
  | { t: 'source'; source: 'native_crm' | 'field_service' }
  | { t: 'count'; w?: string }
  | { t: 'list'; w?: string }
  /** range: the window of 'expiring' written right after it ("expiring this month"). */
  | { t: 'state'; v: StateWord; range?: RelRange }
  | { t: 'stage'; key: string }
  | { t: 'outcome'; v: string }
  | { t: 'enum'; field: string; value: string }
  /** A Custom Module's yes/no field named by its label ("paid jobs": paid is yes). */
  | { t: 'flag'; field: string }
  /** field: a Custom Module date named by its label ("visit date this week"). */
  | { t: 'date'; sel: Sel; value: DateValue; field?: string }
  | { t: 'amount'; op: AmountOp | 'between'; v: number | [number, number]; currency?: string }
  | { t: 'sort'; target: SortTarget; dir?: 'asc' | 'desc'; n?: number }
  | { t: 'top'; n: number }
  | { t: 'group'; field?: string; bucket?: Bucket; sel?: Sel }
  | { t: 'breakdown' }
  | { t: 'or' }
  | { t: 'filler'; w?: string }
  | { t: 'ambiguous' }
  /** A MINE_PHRASES phrase. dateSel: the date a date or a date breakdown right after it is about. */
  | { t: 'mine'; mode: MineMode; place: MinePlace; saysI: boolean; auxiliary: boolean; dateSel?: Sel }
  /** A named metric of the module (registry/metrics.ts). context: its word alone never asks (METRIC_PHRASES). */
  | { t: 'metric'; key: string; context?: true }
  /** "per customer": a named metric broken down by this field (MetricDef.groupBy).
   * first: the breakdown's module named before the metric ("customers by outstanding"; METRIC_GROUP_FIRST). */
  | { t: 'per'; by: string; first?: true }
  /** "compare", "rank", "top": a named metric ranked by its breakdown (METRIC_RANK_WORDS). */
  | { t: 'rank' }
  /** "how much": asks for a total. */
  | { t: 'much' }
  /** How the read is drawn ("as a chart", "line chart", "as a table"; PRESENT_PHRASES, Increment 8). */
  | { t: 'present'; v: PresentWord }
  /** A pipeline word ("deal pipeline", "lead funnel"); module: the module the phrase names itself ("sales pipeline"). */
  | { t: 'pipeline'; module?: string }
  | { t: 'word'; w: string };

type ItemOf<T extends V1Item['t']> = Extract<V1Item, { t: T }>;

interface V1Match { item: V1Item; len: number; priority: number }
interface V1Phrase { words: readonly string[]; item: V1Item; priority: number }
/** A field's label (and other names) after "by", "per", "sorted by". key null: two fields share the words. */
interface FieldPhrase { words: readonly string[]; key: string | null; kind: FieldKind; sortable: boolean; groupable: boolean }
interface ModuleVocab {
  byFirst: ReadonlyMap<string, readonly V1Phrase[]>;
  fields: readonly FieldPhrase[];
  /** Phrases that name exactly one stage or enum value, by their words joined with spaces. */
  values: ReadonlyMap<string, V1Item>;
  /** A Custom Module's date fields by their labels' words (matchCustomDateAt). */
  dateLabels: ReadonlyArray<{ words: readonly string[]; key: string }>;
}

/** At equal length the higher one wins: a state before a date ("due today"),
 * a date before stage words, "mine" words before a tenant's stage or value of
 * the same words, the module's own name before its stage words ("contact" in
 * Contacts), a named metric before a module's name ("invoice totals"), its
 * stage words before another module's name ("customer contacts"), a stage
 * before an outcome or enum value. */
const PRI = {
  state: 100, date: 95, mine: 92, ownModule: 90, metric: 88, amount: 85, stage: 80, shape: 75, outcome: 70, enumValue: 60,
  source: 50, count: 40, list: 30, breakdown: 20, otherModule: 10, filler: 5, or: 1,
} as const;

const DATE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['date', 'datetime']);
/** Sorted largest or latest first unless asked otherwise. */
const DESC_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['number', 'money', 'percent', 'duration', 'date', 'datetime']);
/** "top N" and "latest N": one page of at most this many rows. */
const MAX_TOP = 25;
const MAX_VALUE_WORDS = 6;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function wordsAt(toks: readonly Token[], i: number, words: readonly string[]): boolean {
  return words.length > 0 && words.every((w, k) => {
    const t = toks[i + k];
    return t !== undefined && t.kind === 'word' && t.w === w;
  });
}

function wordAt(toks: readonly WordToken[], i: number): string | undefined {
  return toks[i]?.w;
}

function longestMatch(found: ReadonlyArray<V1Match | null>): V1Match | null {
  let best: V1Match | null = null;
  for (const m of found) {
    if (m && (!best || m.len > best.len || (m.len === best.len && m.priority > best.priority))) best = m;
  }
  return best;
}

function isV1Filler(w: string): boolean {
  return isReadFiller(w) || V1_FILLERS.has(w);
}

/** A filler at toks[i]; "be" never (V1_NOT_FILLERS); "I" only before "want",
 * "see" and the like (I_FOLLOWERS), and not before what the caller wants
 * to do rather than see ("I need to do", "I want to close"; I_WANT_WORDS). */
function isV1FillerAt(toks: readonly WordToken[], i: number): boolean {
  const t = toks[i];
  if (!t || t.num !== undefined || t.glued) return false;
  if (t.w === I_WORD) return isIFillerAt(toks, i + 1);
  if (V1_NOT_FILLERS.has(t.w)) return false;
  return isV1Filler(t.w);
}

/** "I" followed by toks[j]...: "can I see", "I need the open tickets", "I
 * want to see", "I wanna check" ask for records; "I need to do", "I would
 * like to close" are about the caller's own work, so "I" is not a filler. */
function isIFillerAt(toks: readonly WordToken[], j: number): boolean {
  if (!I_FOLLOWERS.has(toks[j]?.w ?? '')) return false;
  let k = j;
  while (k < toks.length && I_WANT_WORDS.has(toks[k].w)) k += 1;
  if (k === j) return true;
  const to = toks[k]?.w === 'to';
  if (!to && toks[k - 1].w !== 'wanna') return true;
  return I_SEE_VERBS.has(toks[to ? k + 1 : k]?.w ?? '');
}

/** Words that are never a one-word stage or enum phrase: a stage labelled
 * "All" must not turn "show all leads" into a filter. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  ...FILLERS, ...V1_FILLERS, ...LIST_VERBS, ...COUNT_WORDS, ...GREETINGS, ...POLITE_PREFIX, HELP_WORD, OR_WORD,
]);

/** The phrases that name one stored value: its key ("in_progress" is "in
 * progress"), its label, and the aliases in vocabulary.ts. alone: false for a
 * vague single word ("other"), which names the value only next to its
 * field's label or a stage word ("other source", "other stage"). */
function valuePhrases(key: string, label: string): Array<{ words: string[]; alone: boolean }> {
  const out = new Map<string, { words: string[]; alone: boolean }>();
  const aliases = hasOwn(VALUE_ALIASES, key) ? VALUE_ALIASES[key].map((p) => [...p]) : [];
  for (const words of [phraseWordsV1(key), phraseWordsV1(label), ...aliases]) {
    if (!words.length || words.length > MAX_VALUE_WORDS) continue;
    if (words.length === 1 && FUNCTION_WORDS.has(words[0])) continue;
    out.set(words.join(' '), { words, alone: !(words.length === 1 && VAGUE_VALUE_WORDS.has(words[0])) });
  }
  return [...out.values()];
}

function fieldLabelWords(info: GrammarModuleInfo, key: string): string[] | null {
  // A Custom Module's multi-select is neither sorted nor counted by, but its label still names its values.
  const f = info.groupable.find((g) => g.key === key) ?? info.sortable.find((s) => s.key === key)
    ?? info.custom?.fields.find((c) => c.key === key);
  const words = f ? phraseWordsV1(f.label) : [];
  return words.length ? words : null;
}

/** Labels (and other names) of the fields executor Q may sort or group by. */
function fieldPhrases(info: GrammarModuleInfo): FieldPhrase[] {
  const byWords = new Map<string, FieldPhrase>();
  const add = (words: readonly string[], key: string, kind: FieldKind) => {
    if (!words.length) return;
    const id = words.join(' ');
    const prev = byWords.get(id);
    if (prev) { if (prev.key !== key) byWords.set(id, { ...prev, key: null }); return; }
    byWords.set(id, {
      words, key, kind,
      sortable: info.sortable.some((f) => f.key === key),
      groupable: info.groupable.some((f) => f.key === key),
    });
  };
  const fields = new Map<string, { key: string; label: string; kind: FieldKind }>();
  for (const f of [...info.sortable, ...info.groupable]) if (!fields.has(f.key)) fields.set(f.key, f);
  for (const f of fields.values()) {
    const words = phraseWordsV1(f.label);
    add(words, f.key, f.kind);
    if (DATE_KINDS.has(f.kind) && words.length && words[words.length - 1] !== 'date') add([...words, 'date'], f.key, f.kind);
    if (f.key === info.stageField) for (const p of STAGE_FIELD_WORDS) add(p, f.key, f.kind);
    if (f.key === info.amountField) for (const p of AMOUNT_FIELD_WORDS) add(p, f.key, f.kind);
    if (f.key === info.dates.created) for (const p of CREATED_FIELD_WORDS) add(p, f.key, f.kind);
  }
  return [...byWords.values()];
}

function buildVocab(ctx: GrammarContext, info: GrammarModuleInfo): ModuleVocab {
  const phrases: V1Phrase[] = [];
  const add = (words: readonly string[], item: V1Item, priority: number) => {
    if (words.length) phrases.push({ words, item, priority });
  };

  for (const s of synonymWords(ctx)) {
    add(s.words, { t: 'module', key: s.key, words: s.words }, s.key === info.key ? PRI.ownModule : PRI.otherModule);
  }
  for (const s of SOURCE_PHRASES) add(s.words, { t: 'source', source: s.source }, PRI.source);
  for (const words of COUNT_PHRASES) add(words, { t: 'count' }, PRI.count);
  for (const w of COUNT_WORDS) add([w], { t: 'count', w }, PRI.count);
  for (const w of LIST_VERBS) add([w], { t: 'list', w }, PRI.list);
  for (const p of STATE_PHRASES) add(p.words, { t: 'state', v: p.state }, PRI.state);
  for (const words of BREAKDOWN_PHRASES) add(words, { t: 'breakdown' }, PRI.breakdown);
  for (const words of V1_FILLER_PHRASES) add(words, { t: 'filler' }, PRI.filler);
  add([OR_WORD], { t: 'or' }, PRI.or);

  // Stage and enum values. A phrase that names two values is ambiguous.
  const values = new Map<string, { words: readonly string[]; hits: Map<string, { item: V1Item; priority: number }> }>();
  const addValue = (words: readonly string[], id: string, item: V1Item, priority: number) => {
    const key = words.join(' ');
    const entry = values.get(key) ?? { words, hits: new Map() };
    entry.hits.set(id, { item, priority });
    values.set(key, entry);
  };
  for (const s of info.stages) {
    for (const { words, alone } of valuePhrases(s.key, s.label)) {
      const item: V1Item = { t: 'stage', key: s.key };
      if (alone) addValue(words, `stage:${s.key}`, item, PRI.stage);
      for (const tail of STAGE_TAILS) addValue([...words, ...tail], `stage:${s.key}`, item, PRI.stage);
    }
  }
  for (const e of info.enums) {
    if (ENUM_FIELDS_NOT_WORDS.has(e.field)) continue;
    const label = fieldLabelWords(info, e.field);
    for (const value of e.values) {
      const item: V1Item = { t: 'enum', field: e.field, value };
      const id = `enum:${e.field}:${value}`;
      for (const { words, alone } of valuePhrases(value, value.replace(/[_-]+/g, ' '))) {
        if (alone) addValue(words, id, item, PRI.enumValue);
        if (label) {
          addValue([...words, ...label], id, item, PRI.enumValue);
          addValue([...label, ...words], id, item, PRI.enumValue);
        }
      }
    }
  }
  // A Custom Module's yes/no fields, by their labels ("paid site visits").
  for (const f of info.custom?.fields ?? []) {
    const words = f.kind === 'boolean' && f.ops.includes('eq') ? phraseWordsV1(f.label) : [];
    if (!words.length || words.length > MAX_VALUE_WORDS || (words.length === 1 && FUNCTION_WORDS.has(words[0]))) continue;
    addValue(words, `flag:${f.key}`, { t: 'flag', field: f.key }, PRI.enumValue);
  }
  const unique = new Map<string, V1Item>();
  for (const [id, { words, hits }] of values) {
    const [only] = [...hits.values()];
    if (hits.size === 1) { add(words, only.item, only.priority); unique.set(id, only.item); }
    else add(words, { t: 'ambiguous' }, PRI.stage);
  }

  // Quotations "pending approval" (decision D4): one stage for every phrase
  // (pendingApprovalStage); words the tenant's own stages or values already
  // use keep their meaning.
  if (info.key === PENDING_APPROVAL.module) {
    const pending = pendingApprovalStage(info.stages);
    for (const words of pending ? PENDING_APPROVAL.words : []) {
      if (!values.has(words.join(' '))) add(words, { t: 'stage', key: pending!.key }, PRI.stage);
    }
  }

  // Outcome words, only for outcomes this tenant's stages tag.
  const tagged = new Set(info.stages.flatMap((s) => (s.outcome ? [s.outcome] : [])));
  for (const [word, outcome] of Object.entries(OUTCOME_WORDS)) {
    if (tagged.has(outcome)) add([word], { t: 'outcome', v: outcome }, PRI.outcome);
  }

  // The module's named metrics (registry/metrics.ts), "how much", and their
  // breakdowns named by the other module's own words ("per customer", or
  // first: "customers by outstanding"), ranked ("top 5 customers by ...").
  const metrics = info.custom ? [] : metricsFor(info.key);
  for (const m of metrics) {
    for (const words of metricWords(m)) add(words.words, { t: 'metric', key: m.key, ...(words.context ? { context: true as const } : {}) }, PRI.metric);
  }
  if (metrics.length) add(HOW_MUCH, { t: 'much' }, PRI.count);
  const groupBys = uniq(metrics.flatMap((m) => [...m.groupBy]));
  for (const by of groupBys) {
    const module = hasOwn(METRIC_GROUP_FIELDS, by) ? METRIC_GROUP_FIELDS[by] : undefined;
    for (const s of synonymWords(ctx).filter((x) => x.key === module && !x.custom)) {
      const item: V1Item = { t: 'per', by };
      for (const intro of METRIC_GROUP_INTROS) add([...intro, ...s.words], item, PRI.shape);
      add([...s.words, METRIC_GROUP_TAIL], item, PRI.shape);
      if (s.words.length === 1) add([`${s.words[0]}${METRIC_GROUP_TAIL}`], item, PRI.shape);
      for (const tail of METRIC_GROUP_FIRST) add([...s.words, ...tail], { t: 'per', by, first: true }, PRI.shape);
    }
  }
  if (groupBys.length) for (const w of METRIC_RANK_WORDS) add([w], { t: 'rank' }, PRI.shape);

  // How the read is drawn, and the module's pipeline (Increment 8), unless the
  // tenant's own stages or values use the words (a stage labelled "Table").
  for (const p of PRESENT_PHRASES) {
    if (!values.has(p.words.join(' '))) add(p.words, { t: 'present', v: p.present }, PRI.shape);
  }
  for (const w of PIPELINE_WORDS) if (!values.has(w)) add([w], { t: 'pipeline' }, PRI.shape);
  if (info.key === SALES_PIPELINE.module) {
    for (const words of salesPipelineWords(ctx)) {
      if (!values.has(words.join(' '))) add(words, { t: 'pipeline', module: info.key }, PRI.shape);
    }
  }

  const byFirst = new Map<string, V1Phrase[]>();
  for (const p of phrases) {
    const list = byFirst.get(p.words[0]);
    if (list) list.push(p);
    else byFirst.set(p.words[0], [p]);
  }
  const dateLabels = (info.custom?.fields ?? [])
    .filter((f) => (f.kind === 'date' || f.kind === 'datetime') && f.ops.includes('within'))
    .map((f) => ({ words: phraseWordsV1(f.label), key: f.key }))
    .filter((d) => d.words.length > 0);
  return { byFirst, fields: fieldPhrases(info), values: unique, dateLabels };
}

/** The quotation stage "pending quotations" and "awaiting approval" mean
 * (decision D4, PENDING_APPROVAL), in three steps: the tenant's stage keyed
 * or labelled "pending"; else its one approval stage of its own ("Pending
 * Approval", "Awaiting Approval", "Approval Pending"; with two, neither);
 * else its stage keyed 'sent'. */
function pendingApprovalStage(stages: readonly StageWord[]): StageWord | undefined {
  const own = stages.find((s) => s.key === PENDING_APPROVAL.own || phraseWordsV1(s.label).join(' ') === PENDING_APPROVAL.own);
  if (own) return own;
  const named = (words: readonly string[]): boolean => words.some((w) => PENDING_APPROVAL.waiting.has(w))
    || (words.includes(PENDING_APPROVAL.approval) && !words.includes(PENDING_APPROVAL.approved));
  const approval = stages.filter((s) => !s.terminal && !s.outcome && s.key !== PENDING_APPROVAL.stage
    && (named(phraseWordsV1(s.key)) || named(phraseWordsV1(s.label))));
  return approval.length === 1 ? approval[0] : stages.find((s) => s.key === PENDING_APPROVAL.stage);
}

/** A named metric's words: its own synonyms (registry/metrics.ts) and the grammar's (METRIC_PHRASES). */
function metricWords(m: MetricDef): Array<{ words: readonly string[]; context?: true }> {
  return [
    ...m.synonyms.map((s) => ({ words: phraseWordsV1(s) })),
    ...METRIC_PHRASES.filter((p) => p.metric === m.key).map((p) => ({ words: p.words, ...(p.context ? { context: p.context } : {}) })),
  ].filter((p) => p.words.length > 0);
}

/** A module's words as v1 words: the registry synonyms, then (Increment 5) the
 * names of the caller's Custom Modules (custom). A Custom Module name that is
 * one function word ("All") names nothing: "show all leads" would name two
 * modules. */
type ModuleWords = ReadonlyArray<{ key: string; words: readonly string[]; custom?: true }>;

const NO_CUSTOM_MODULES: readonly CustomModuleInfo[] = [];
const synonymCache = new WeakMap<object, WeakMap<object, ModuleWords>>();

function synonymWords(ctx: GrammarContext): ModuleWords {
  const custom = ctx.customModules?.length ? ctx.customModules : NO_CUSTOM_MODULES;
  let byCustom = synonymCache.get(ctx.synonyms);
  if (!byCustom) {
    byCustom = new WeakMap();
    synonymCache.set(ctx.synonyms, byCustom);
  }
  let words = byCustom.get(custom);
  if (!words) {
    const registry = ctx.synonyms.map((s) => ({ key: s.key, words: phraseWordsV1(s.phrase) })).filter((s) => s.words.length > 0);
    const named = custom.flatMap((m) => m.words.map((w) => ({ key: m.key, words: phraseWordsV1(w), custom: true as const })))
      .filter((s) => s.words.length > 0 && !(s.words.length === 1 && FUNCTION_WORDS.has(s.words[0])));
    words = [...registry, ...named];
    byCustom.set(custom, words);
  }
  return words;
}

/** "sales pipeline", "sales funnel" (the deals', decision N25), less those
 * that name one of the caller's Custom Modules: those read that module, as
 * before Increment 8 ("show sales pipeline"), never the deals. */
function salesPipelineWords(ctx: GrammarContext): ReadonlyArray<readonly string[]> {
  const custom = new Set(synonymWords(ctx).flatMap((s) => (s.custom ? [s.words.join(' ')] : [])));
  return SALES_PIPELINE.words.filter((words) => !custom.has(words.join(' ')));
}

const vocabCache = new WeakMap<GrammarModuleInfo, { words: ModuleWords; vocab: ModuleVocab }>();

function vocabFor(ctx: GrammarContext, info: GrammarModuleInfo): ModuleVocab {
  const words = synonymWords(ctx);
  const hit = vocabCache.get(info);
  if (hit && hit.words === words) return hit.vocab;
  const vocab = buildVocab(ctx, info);
  vocabCache.set(info, { words, vocab });
  return vocab;
}

/* ── v1 matchers: each reads the longest phrase of its kind at token i ──── */

function fieldPhraseAt(vocab: ModuleVocab, toks: readonly WordToken[], i: number): FieldPhrase | null {
  let best: FieldPhrase | null = null;
  for (const f of vocab.fields) if ((!best || f.words.length > best.words.length) && wordsAt(toks, i, f.words)) best = f;
  return best;
}

/** A whole number written in digits ("5", not "5k" or "2.5") or as a word ("five"). */
function countAt(toks: readonly WordToken[], i: number): number | null {
  const t = toks[i];
  if (!t || t.neg) return null;
  if (t.num !== undefined) return /^\d+$/.test(t.w) && !toks[i + 1]?.glued ? t.num : null;
  return hasOwn(NUMBER_WORDS, t.w) ? NUMBER_WORDS[t.w] : null;
}

function dateFieldFor(info: GrammarModuleInfo, sel: Sel): string | undefined {
  switch (sel) {
    case 'default': return info.dates.default;
    case 'created': return info.dates.created;
    case 'due': return info.dates.due;
    case 'start': return info.dates.start;
    case 'end': return info.dates.end;
    case 'close': {
      // "closing" is the due date only where that date is a close date (deals, leads).
      const due = info.dates.due;
      const label = due ? [...info.sortable, ...info.groupable].find((f) => f.key === due)?.label : undefined;
      return label && /\bclos(e|ing)\b/i.test(label) ? due : undefined;
    }
    default: return undefined;
  }
}

/** The date "overdue" and "due today" are about (QueryCaps.due: the due date, else the start). */
function dueFieldOf(info: GrammarModuleInfo): string | undefined {
  return info.dates.due ?? info.dates.start;
}

/** A past date (when a record was created, or an expense's date): a day or
 * month written without a year that is still to come means last year's. */
function isPastDate(info: GrammarModuleInfo, field: string | undefined): boolean {
  if (!field) return false;
  if (field === info.dates.created) return true;
  return field !== info.dates.due && field !== info.dates.start && field !== info.dates.end;
}

function isDateUsable(info: GrammarModuleInfo, field: string): boolean {
  return info.dateFields ? info.dateFields.includes(field) : true;
}

function isSortable(info: GrammarModuleInfo, key: string): boolean {
  return info.sortable.some((f) => f.key === key);
}

/** [created | due | scheduled | closing | ending] then a date phrase (dates.ts).
 * A date phrase alone is about `bare`: the module's default date, or what
 * "mine" said before it ("tasks I created this week"; segmentV1). */
function matchDateAt(
  toks: readonly WordToken[], i: number, info: GrammarModuleInfo, todayKey: string | undefined, bare: Sel = 'default',
): V1Match | null {
  const opts = (sel: Sel) => ({ ...(todayKey ? { todayKey } : {}), past: isPastDate(info, dateFieldFor(info, sel)) });
  const found: Array<V1Match | null> = [];
  const w = wordAt(toks, i);
  // Where records can expire, "expiring" is that state (matchExpiringAt), never just the end date.
  if (w !== undefined && hasOwn(DATE_FIELD_WORDS, w) && !(info.states.expiring && EXPIRING_WORDS.has(w))) {
    const sel = DATE_FIELD_WORDS[w];
    const m = matchDateExpr(toks, i + 1, opts(sel));
    if (m) found.push({ item: { t: 'date', sel, value: m.value }, len: 1 + m.length, priority: PRI.date });
  }
  const m = matchDateExpr(toks, i, opts(bare));
  if (m) found.push({ item: { t: 'date', sel: bare, value: m.value }, len: m.length, priority: PRI.date });
  return longestMatch(found);
}

/** The single words of EXPIRING_PHRASES ("expiring", "expires"). */
const EXPIRING_WORDS: ReadonlySet<string> = new Set(EXPIRING_PHRASES.filter((p) => p.length === 1).map((p) => p[0]));

/** "expiring", "expiring soon", "about to expire" (EXPIRING_PHRASES), only
 * where the module's records can expire: the 'expiring' state, with the
 * relative range written right after it as its window when that is from
 * today on ("expiring this month", "expiring in the next 7 days";
 * EXPIRING_WINDOWS). Any other date after it is not its window and is
 * refused with it ("expiring in November", "expiring last month"; readCore). */
function matchExpiringAt(toks: readonly WordToken[], i: number, info: GrammarModuleInfo): V1Match | null {
  if (!info.states.expiring) return null;
  const found: V1Match[] = [];
  for (const p of EXPIRING_PHRASES) {
    if (!wordsAt(toks, i, p)) continue;
    found.push({ item: { t: 'state', v: 'expiring' }, len: p.length, priority: PRI.state });
    for (const prefix of [[] as readonly string[], ...DATE_PREFIXES]) {
      const j = i + p.length;
      if (prefix.length && !wordsAt(toks, j, prefix)) continue;
      const rel = relRangeAt(toks, j + prefix.length);
      if (rel && EXPIRING_WINDOWS.has(rel.rel)) {
        found.push({ item: { t: 'state', v: 'expiring', range: rel.rel }, len: p.length + prefix.length + rel.length, priority: PRI.state });
      }
    }
  }
  return longestMatch(found);
}

/** A Custom Module date named by its label, then a date phrase ("visit date
 * this week", "visit date in November": the current year's, as its records
 * may be planned ahead). */
function matchCustomDateAt(toks: readonly WordToken[], i: number, vocab: ModuleVocab, todayKey: string | undefined): V1Match | null {
  const found: V1Match[] = [];
  for (const d of vocab.dateLabels) {
    if (!wordsAt(toks, i, d.words)) continue;
    const m = matchDateExpr(toks, i + d.words.length, todayKey ? { todayKey } : {});
    if (m) found.push({ item: { t: 'date', sel: 'default', value: m.value, field: d.key }, len: d.words.length + m.length, priority: PRI.date });
  }
  return longestMatch(found);
}

function amountItem(op: AmountOp | 'between', v: number | [number, number], currency?: string): V1Item {
  return { t: 'amount', op, v, ...(currency ? { currency } : {}) };
}

/** "between 10,000 and 50,000", "from 1 to 2 lakh": the second amount's
 * multiplier counts for the first too when that still makes a range. Bare
 * numbers up to 31 could be days of a month, so they are not amounts here. */
function moneyRangeAt(toks: readonly WordToken[], i: number): { len: number; lo: number; hi: number; currency?: string } | null {
  const intro = wordAt(toks, i);
  const joiner = intro === 'between' ? 'and' : intro === 'from' ? 'to' : null;
  if (!joiner) return null;
  const a = matchMoney(toks, i + 1);
  if (!a || wordAt(toks, i + 1 + a.length) !== joiner) return null;
  const b = matchMoney(toks, i + 2 + a.length);
  if (!b) return null;
  const end = i + 2 + a.length + b.length;
  const next = wordAt(toks, end);
  if (next !== undefined && (hasOwn(MONTH_NAMES, next) || ORDINAL_SUFFIXES.has(next))) return null;
  if (a.currency && b.currency && a.currency !== b.currency) return null;
  let lo = a.value;
  const hi = b.value;
  if (a.multiplier === undefined && b.multiplier !== undefined) {
    const carried = roundAmount(a.base * b.multiplier);
    if (carried <= hi) lo = carried;
  }
  if (lo > hi) return null;
  if (!a.currency && !b.currency && a.multiplier === undefined && b.multiplier === undefined && hi <= 31) return null;
  const currency = a.currency ?? b.currency;
  return { len: end - i, lo, hi, ...(currency ? { currency } : {}) };
}

/** "more than 1 lakh", "worth over ₹50,000", "under 10k", "between 1 and 2
 * crore", "5000 and above". */
function matchAmountAt(toks: readonly WordToken[], i: number): V1Match | null {
  const found: V1Match[] = [];
  for (const lead of [[] as readonly string[], ...AMOUNT_LEADS]) {
    if (lead.length && !wordsAt(toks, i, lead)) continue;
    const j = i + lead.length;
    for (const c of AMOUNT_COMPARATORS) {
      if (!wordsAt(toks, j, c.words)) continue;
      const m = matchMoney(toks, j + c.words.length);
      if (m) found.push({ item: amountItem(c.op, m.value, m.currency), len: lead.length + c.words.length + m.length, priority: PRI.amount });
    }
    const range = moneyRangeAt(toks, j);
    if (range) found.push({ item: amountItem('between', [range.lo, range.hi], range.currency), len: lead.length + range.len, priority: PRI.amount });
  }
  const m = matchMoney(toks, i);
  if (m) {
    for (const e of AMOUNT_OPEN_ENDS) {
      if (wordsAt(toks, i + m.length, e.words)) {
        found.push({ item: amountItem(e.op, m.value, m.currency), len: m.length + e.words.length, priority: PRI.amount });
      }
    }
  }
  return longestMatch(found);
}

function sortDirectionAt(toks: readonly WordToken[], i: number): { dir: 'asc' | 'desc'; len: number } | null {
  let best: { dir: 'asc' | 'desc'; len: number } | null = null;
  for (const d of SORT_DIRECTIONS) if ((!best || d.words.length > best.len) && wordsAt(toks, i, d.words)) best = { dir: d.dir, len: d.words.length };
  return best;
}

/** "latest", "5 newest", "highest first", "sorted by close date", "by amount". */
function matchSortAt(toks: readonly WordToken[], i: number, vocab: ModuleVocab): V1Match | null {
  const found: V1Match[] = [];
  const push = (item: V1Item, len: number) => found.push({ item, len, priority: PRI.shape });
  // "highest value deals", "5 largest amount invoices": the amount named after an amount sort word.
  const amountWordsAt = (j: number): number => AMOUNT_FIELD_WORDS.find((p) => wordsAt(toks, j, p))?.length ?? 0;
  for (const s of SORT_WORDS) {
    const target: SortTarget = { kind: s.by };
    if (wordsAt(toks, i, s.words)) {
      let len = s.words.length;
      const n = countAt(toks, i + len);
      if (n !== null) len += 1;
      if (s.by === 'amount') len += amountWordsAt(i + len);
      if (wordsAt(toks, i + len, SORT_WORD_TAIL)) len += SORT_WORD_TAIL.length;
      push({ t: 'sort', target, dir: s.dir, ...(n !== null ? { n } : {}) }, len);
    }
    const before = countAt(toks, i);
    if (before !== null && wordsAt(toks, i + 1, s.words)) {
      const len = 1 + s.words.length;
      push({ t: 'sort', target, dir: s.dir, n: before }, len + (s.by === 'amount' ? amountWordsAt(i + len) : 0));
    }
  }
  for (const intro of SORT_BY_PHRASES) {
    if (!wordsAt(toks, i, intro)) continue;
    const f = fieldPhraseAt(vocab, toks, i + intro.length);
    if (!f || !f.key || !f.sortable) continue;
    const d = sortDirectionAt(toks, i + intro.length + f.words.length);
    push({ t: 'sort', target: { kind: 'field', key: f.key }, ...(d ? { dir: d.dir } : {}) }, intro.length + f.words.length + (d?.len ?? 0));
  }
  if (wordAt(toks, i) === BY_WORD) {
    // "by <field>" sorts when a direction follows, or for a number, amount or
    // date; a groupable field means a breakdown (matchGroupAt).
    const f = fieldPhraseAt(vocab, toks, i + 1);
    if (f && f.key && f.sortable) {
      const d = sortDirectionAt(toks, i + 1 + f.words.length);
      if (d) push({ t: 'sort', target: { kind: 'field', key: f.key }, dir: d.dir }, 1 + f.words.length + d.len);
      else if (DESC_KINDS.has(f.kind) && !(f.groupable && !DATE_KINDS.has(f.kind))) push({ t: 'sort', target: { kind: 'field', key: f.key } }, 1 + f.words.length);
    }
  }
  return longestMatch(found);
}

function matchTopAt(toks: readonly WordToken[], i: number): V1Match | null {
  if (wordAt(toks, i) !== TOP_WORD) return null;
  const n = countAt(toks, i + 1);
  return n === null ? null : { item: { t: 'top', n }, len: 2, priority: PRI.shape };
}

/** "by source", "per status", "grouped by priority", "per month", "each
 * week", "created per month". A bucket alone is of `bare` (matchDateAt).
 * `expires`: the module's records can expire (GrammarModuleInfo.states). */
function matchGroupAt(toks: readonly WordToken[], i: number, vocab: ModuleVocab, bare: Sel = 'default', expires = false): V1Match | null {
  const found: V1Match[] = [];
  const push = (item: V1Item, len: number) => found.push({ item, len, priority: PRI.shape });
  const bucketAt = (j: number): Bucket | null => {
    const w = wordAt(toks, j);
    return w !== undefined && hasOwn(BUCKET_WORDS, w) ? BUCKET_WORDS[w] : null;
  };
  const intros: ReadonlyArray<readonly string[]> = [...GROUP_BY_PHRASES, [BY_WORD]];
  for (const intro of intros) {
    if (!wordsAt(toks, i, intro)) continue;
    const j = i + intro.length;
    const f = fieldPhraseAt(vocab, toks, j);
    if (f && f.key && f.groupable && !DATE_KINDS.has(f.kind)) push({ t: 'group', field: f.key }, intro.length + f.words.length);
    const bucket = bucketAt(j);
    if (bucket) push({ t: 'group', bucket, sel: bare }, intro.length + 1);
  }
  if (wordAt(toks, i) === EACH_WORD) {
    const bucket = bucketAt(i + 1);
    if (bucket) push({ t: 'group', bucket, sel: bare }, 2);
  }
  const w = wordAt(toks, i);
  // Where records can expire, "expiring" is that state, never just the end date (matchDateAt).
  if (w !== undefined && hasOwn(DATE_FIELD_WORDS, w) && !(expires && EXPIRING_WORDS.has(w))) {
    const sel = DATE_FIELD_WORDS[w];
    for (const intro of [...intros, [EACH_WORD]]) {
      if (!wordsAt(toks, i + 1, intro)) continue;
      const bucket = bucketAt(i + 1 + intro.length);
      if (bucket) push({ t: 'group', bucket, sel }, 2 + intro.length);
    }
  }
  return longestMatch(found);
}

/** "monthly work orders", "work orders monthly", "monthly collections"
 * (Increment 8, spec B8.2): a bucket adjective right before or right after
 * the module's own name or a named total (`prev`: the item read before it),
 * read as "per month" is. Anywhere else it is a word, as before Increment 8:
 * in a name ("invoices of Annual", "work orders for Daily Fresh") or a value
 * ("annual maintenance contracts" are AMC ones, not maintenance ones per
 * year). A word that is one of the module's values keeps that meaning. */
function matchBucketAdjectiveAt(
  toks: readonly WordToken[], i: number, vocab: ModuleVocab, info: GrammarModuleInfo, prev: V1Item | undefined, bare: Sel,
): V1Match | null {
  const w = wordAt(toks, i);
  if (w === undefined || !hasOwn(BUCKET_ADJECTIVES, w) || namesValue(vocab, w)) return null;
  const names = (it: V1Item | undefined): boolean => it?.t === 'metric' || (it?.t === 'module' && it.key === info.key);
  const next = longestMatch((vocab.byFirst.get(wordAt(toks, i + 1) ?? '') ?? [])
    .map((p) => (wordsAt(toks, i + 1, p.words) ? { item: p.item, len: p.words.length, priority: p.priority } : null)))?.item;
  if (!names(next) && !(names(prev) && !(next && VALUE_ITEM_KINDS.has(next.t)))) return null;
  return { item: { t: 'group', bucket: BUCKET_ADJECTIVES[w], sel: bare }, len: 1, priority: PRI.shape };
}

/** The longest "mine" phrase at toks[i] (MINE_PHRASES), unless the word
 * after it makes it something else ("my team's leads", "deals I have to
 * close"). Where it stands is checked once the module is known (mineOf). */
function matchMineAt(toks: readonly WordToken[], i: number, info: GrammarModuleInfo): V1Match | null {
  let best: MinePhrase | null = null;
  for (const p of MINE_PHRASES) {
    if ((best && p.words.length <= best.words.length) || !wordsAt(toks, i, p.words)) continue;
    if (p.notBefore?.has(wordAt(toks, i + p.words.length) ?? '')) continue;
    best = p;
  }
  if (!best) return null;
  const dateSel: Sel | undefined = best.verb === undefined ? undefined
    : MINE_EVENT_VERBS.has(best.verb) && isEventDated(info) ? 'default' : 'created';
  return {
    item: {
      t: 'mine', mode: best.mode, place: best.place, saysI: !!best.saysI, auxiliary: !!best.auxiliary,
      ...(dateSel ? { dateSel } : {}),
    },
    len: best.words.length,
    priority: PRI.mine,
  };
}

/** One item and the words it was read from: toks[at] to toks[at + len - 1]. */
interface Seg { item: V1Item; at: number; len: number }

/** Longest phrase first at every position; a word nothing matches is a
 * filler or an unknown word. */
function segmentSpans(toks: readonly WordToken[], vocab: ModuleVocab, info: GrammarModuleInfo, todayKey: string | undefined): Seg[] {
  const segs: Seg[] = [];
  // Right after "I created" or "raised by me" (fillers aside), a date or a
  // date breakdown is about when the records were created, as right after
  // "created" itself ("tasks I created this week" are not tasks due this
  // week), or a call's own date after "I made" (MINE_EVENT_VERBS).
  let bare: Sel = 'default';
  // In a name ("invoices for Trend Micro", "work orders for Acme Board",
  // "site visits named Daily Fresh": nameAt) the presentation and pipeline
  // words of Increment 8 are words, as before it, except an "as" form ("for
  // Acme as a chart"), which says how the read is drawn. naming: the last
  // word read is in such a name; like nameAt, a name goes on through a filler
  // and another module's name ("Farm to Table", "Acme Services Board").
  const drawn = (m: V1Match | null): boolean => !!m && (m.item.t === 'present' || m.item.t === 'pipeline');
  let naming = false;
  let i = 0;
  while (i < toks.length) {
    const found: Array<V1Match | null> = [];
    for (const p of vocab.byFirst.get(toks[i].w) ?? []) {
      if (wordsAt(toks, i, p.words)) found.push({ item: p.item, len: p.words.length, priority: p.priority });
    }
    found.push(
      matchDateAt(toks, i, info, todayKey, bare), matchAmountAt(toks, i), matchSortAt(toks, i, vocab), matchTopAt(toks, i),
      matchGroupAt(toks, i, vocab, bare, info.states.expiring), matchMineAt(toks, i, info), matchExpiringAt(toks, i, info),
      matchCustomDateAt(toks, i, vocab, todayKey), matchBucketAdjectiveAt(toks, i, vocab, info, segs[segs.length - 1]?.item, bare),
    );
    const inName: boolean = naming || opensName(toks, segs, info);
    let best = longestMatch(found);
    if (inName && drawn(best) && toks[i].w !== AS_WORD) best = longestMatch(found.filter((m) => !drawn(m)));
    const item: V1Item = best ? best.item : isV1FillerAt(toks, i) ? { t: 'filler', w: toks[i].w } : { t: 'word', w: toks[i].w };
    if (item.t === 'mine') bare = item.dateSel ?? 'default';
    else if (item.t !== 'filler') bare = 'default';
    naming = inName && (item.t === 'module' ? item.key !== info.key
      : (best ? best.len : 1) === 1 && (item.t === 'word' || item.t === 'filler') && !NAME_END_WORDS.has(toks[i].w));
    segs.push({ item, at: i, len: best ? best.len : 1 });
    i += best ? best.len : 1;
  }
  return segs;
}

/** Whether a name may start at the word after `segs` (nameAt): right after
 * "for" or "of" (forReadings), a parent's name after them ("for customer
 * Trend Micro") or "named", "containing" and the other SEARCH_PHRASES
 * (searchReadings), articles aside ("for the Daily Grind"). */
function opensName(toks: readonly WordToken[], segs: readonly Seg[], info: GrammarModuleInfo): boolean {
  const article = (k: number): boolean => segs[k]?.item.t === 'filler' && NAME_ARTICLES.has(toks[segs[k].at].w);
  let s = segs.length - 1;
  while (article(s)) s -= 1;
  const seg = segs[s];
  if (!seg) return false;
  const end = seg.at + seg.len;
  if (isLoose(seg) && (FOR_WORDS.has(toks[seg.at].w) || SEARCH_PHRASES.some((p) => p.length <= end && wordsAt(toks, end - p.length, p)))) return true;
  if (seg.item.t !== 'module' || seg.item.key === info.key) return false;
  s -= 1;
  while (article(s)) s -= 1;
  return isLoose(segs[s]) && FOR_WORDS.has(toks[segs[s].at].w);
}

function segmentV1(toks: readonly WordToken[], vocab: ModuleVocab, info: GrammarModuleInfo, todayKey: string | undefined): V1Item[] {
  return segmentSpans(toks, vocab, info, todayKey).map((s) => s.item);
}

/* ── v1 plans ─────────────────────────────────────────────────────────── */

function dateCondition(field: string, value: DateValue): Cond {
  if (value.kind === 'within') return { f: field, op: 'within', v: value.rel };
  if (value.kind === 'between') return { f: field, op: 'between', v: [value.from, value.to] };
  return { f: field, op: value.op, v: value.at };
}

function amountSort(info: GrammarModuleInfo, dir: 'asc' | 'desc'): { by: string; dir: 'asc' | 'desc' } | null {
  const field = info.amountField;
  return field && isSortable(info, field) ? { by: field, dir } : null;
}

/** Calls and meetings: the default date is when the call or meeting itself
 * happens (it is the start date, and there is no separate due date). */
function isEventDated(info: GrammarModuleInfo): boolean {
  return !!info.dates.start && info.dates.default === info.dates.start && !info.dates.due;
}

/** The sort a sort word or "sorted by" names; 'default' when it is what the
 * module's list returns anyway ("latest customers"; "recent calls", whose
 * list is newest call first). */
function resolveSort(info: GrammarModuleInfo, target: SortTarget, dir: 'asc' | 'desc' | undefined): { by: string; dir: 'asc' | 'desc' } | 'default' | null {
  if (target.kind === 'amount') return amountSort(info, dir ?? 'desc');
  if (target.kind === 'created') {
    const field = info.dates.created;
    const d = dir ?? 'desc';
    if (isSortable(info, field)) return { by: field, dir: d };
    const def = info.defaultSort;
    if (!def || def.dir !== d) return null;
    return def.by === field || (isEventDated(info) && def.by === info.dates.default) ? 'default' : null;
  }
  const f = info.sortable.find((x) => x.key === target.key);
  return f ? { by: f.key, dir: dir ?? (DESC_KINDS.has(f.kind) ? 'desc' : 'asc') } : null;
}

type Present = NonNullable<QueryPlan['present']>;

/** "how many customers": one count per source, never summed (D1); "how many
 * customers do I have" counts the caller's own in each source; "... as a
 * chart" draws it (Increment 8: the composer says a chart needs a breakdown). */
const conceptCount = (mine?: MineMode, present?: Present): GrammarParse => ({
  kind: 'concept_count', op: 'count', concept: 'customer', modules: ['customer'],
  filterKeys: [...(mine ? ['mine'] : []), ...(present ? ['present'] : [])],
  plan: { v: 1, op: 'count', target: { concept: 'customer' }, ...(mine ? { mine } : {}), ...(present ? { present } : {}) },
});

/** readV1's answer when a rule refuses the message because reading it would
 * answer something else than was asked (the opposite set, no set at all, the
 * caller's own work, an agenda): not "can't read" (null) but "must not be
 * read", which parseMessage honours over grammar v0's plain read. */
const REFUSED = 'refused' as const;
type Refused = typeof REFUSED;

/** "what do we need to do today", "what is there to do", "show me what we
 * need to do": the task words "to do" right after AGENDA_LEADS are the verb,
 * an agenda question; "show to do tasks", "tasks to do" are the list. */
function isAgenda(items: readonly V1Item[]): boolean {
  return items.some((it, k) => {
    if (it.t !== 'module' || !TO_DO_WORDS.has(it.words.join(' '))) return false;
    const wordOf = (x: V1Item | undefined): string => (x?.t === 'filler' || x?.t === 'word' ? x.w ?? '' : '');
    let j = k - 1;
    while (j >= 0 && AGENDA_GAP_WORDS.has(wordOf(items[j]))) j -= 1;
    return AGENDA_LEADS.has(wordOf(items[j]));
  });
}

/** A stage, state, outcome, enum value or yes/no field. */
function isValueItem(it: V1Item | undefined): boolean {
  return !!it && (it.t === 'stage' || it.t === 'state' || it.t === 'outcome' || it.t === 'enum' || it.t === 'flag');
}

/** A stage or value name that reads as a past participle ("Contacted",
 * "Meeting Scheduled", "Sent"; DONE_WORDS). */
function namesDone(name: string): boolean {
  return phraseWordsV1(name).some((w) => /\p{L}{2}ed$/u.test(w) || DONE_WORDS.has(w));
}

/** Right after "I have", a value that is what the caller did rather than what
 * they have (MinePhrase.auxiliary): the closed state, an outcome, a finished
 * stage, or a stage or enum value named by a past participle ("leads I have
 * contacted"). Open, overdue and due today, and values like "hot" or "on
 * hold", are not. */
function isDoneItem(it: V1Item | undefined, info: GrammarModuleInfo): boolean {
  if (!it) return false;
  if (it.t === 'state') return it.v === 'closed';
  if (it.t === 'outcome') return true;
  if (it.t === 'enum') return namesDone(it.value);
  if (it.t !== 'stage') return false;
  const stage = info.stages.find((s) => s.key === it.key);
  return !stage || stage.terminal || namesDone(stage.key) || namesDone(stage.label);
}

/** The read's "mine": undefined when the message has none. null when a
 * phrase stands where it names nothing of the module ("leads my", "by me"
 * after anything but a created date) or two phrases disagree ("my leads I
 * created": assigned or created?). REFUSED when such a phrase is the
 * caller's "I" ("I have leads"), or "have" is what the caller did ("tickets
 * I have resolved"; MinePhrase.auxiliary, isDoneItem): as any other "I",
 * that must not fall back to grammar v0's plain read of every record. */
function mineOf(items: readonly V1Item[], info: GrammarModuleInfo): MineMode | undefined | null | Refused {
  // A named metric names its module's records too ("my outstanding"), as "sales pipeline" does ("my sales pipeline").
  const modules = items.flatMap((it, k) => (it.t === 'module' || it.t === 'metric' || (it.t === 'pipeline' && it.module) ? [k] : []));
  const first = modules[0] ?? -1;
  const last = modules[modules.length - 1] ?? -1;
  const modes = new Set<MineMode>();
  let misplaced: null | Refused | undefined;
  /** "leads created this week by me": a created date or breakdown right before (fillers aside). */
  const afterCreated = (k: number): boolean => {
    const prev = items.slice(0, k).reverse().find((x) => x.t !== 'filler');
    return (prev?.t === 'date' || prev?.t === 'group') && prev.sel === 'created';
  };
  items.forEach((it, k) => {
    if (it.t !== 'mine') return;
    modes.add(it.mode);
    const placed = it.place === 'any'
      || (it.place === 'before' && k < last)
      || (it.place === 'after' && first >= 0 && k > first)
      || (it.place === 'tail' && afterCreated(k));
    const did = it.auxiliary && isDoneItem(items[k + 1], info) && k > last;
    if (!placed || did) misplaced = it.saysI ? REFUSED : misplaced ?? null;
  });
  if (misplaced !== undefined) return misplaced;
  if (modes.size > 1) return null;
  return modes.size ? [...modes][0] : undefined;
}

/** "invoices to get paid", "tasks we need to get done", "leads to get to
 * qualified", "invoices to get all paid": past the start of the message,
 * "get" before a stage, state or value (only fillers between) says the
 * records are not there yet, the opposite of that value ("get paid
 * invoices" and "can I get the open tickets" ask for them). */
function getsValue(items: readonly V1Item[]): boolean {
  const first = items.findIndex((it) => it.t !== 'filler');
  const nextMeaningful = (k: number): V1Item | undefined => items.slice(k + 1).find((it) => it.t !== 'filler');
  return items.some((it, k) => it.t === 'list' && it.w === GET_WORD && k !== first && isValueItem(nextMeaningful(k)));
}

/** A stage an expiring record can be in, as query/compile.ts reads it: any
 * stage that isn't terminal, or where only running records expire
 * (QueryCaps.expiring.running 'active': contracts) the stages tagged with the
 * outcome active, else the stage keyed active. */
function runsWhileExpiring(info: GrammarModuleInfo, s: StageWord): boolean {
  if (info.expiring?.running !== 'active') return !s.terminal;
  return info.stages.some((x) => x.outcome === 'active') ? s.outcome === 'active' : s.key === 'active';
}

/** A Custom Module multi-select: "urgent and vip" could ask for both values, or either. */
function isMultiSelect(info: GrammarModuleInfo, field: string): boolean {
  return info.custom?.fields.some((f) => f.key === field && f.kind === 'multi') ?? false;
}

interface Conditions {
  where: Cond[];
  keys: Set<string>;
  state: StateWord | null;
  /** How many amounts were compared (a list compared by amount sorts by it). */
  amounts: number;
}

/** The conditions a reading's items name (states, stages, outcomes, values,
 * dates and amounts), with every rule that keeps a reading from naming the
 * opposite set or no set at all; null or REFUSED as readCore's. `bareDate`:
 * where a date written alone goes when that isn't the module's default date
 * (a named metric's, METRIC_BARE_DATES); null: such a date is not read. */
function conditionsOf(
  items: readonly V1Item[], ctx: GrammarContext, info: GrammarModuleInfo, bareDate?: string | null,
): Conditions | Refused | null {
  const of = <T extends V1Item['t']>(t: T): Array<ItemOf<T>> => items.filter((it): it is ItemOf<T> => it.t === t);
  const states = new Set(of('state').map((s) => s.v));
  const stages = uniq(of('stage').map((s) => s.key));
  const outcomes = uniq(of('outcome').map((o) => o.v));
  const enums = new Map<string, string[]>();
  for (const e of of('enum')) {
    const list = enums.get(e.field) ?? [];
    if (!list.includes(e.value)) list.push(e.value);
    enums.set(e.field, list);
  }
  const dates = of('date');
  const amounts = of('amount');
  const sorts = of('sort');
  const where: Cond[] = [];
  const keys = new Set<string>();
  /** The 'expiring' condition: a date written alone may still give it its window (the dates below). */
  let expiring: Extract<Cond, { op: 'state' }> | undefined;

  // States: overdue, due today and expiring already mean open.
  if (states.has('open') && (states.has('overdue') || states.has('due_today') || states.has('expiring'))) states.delete('open');
  if (states.size > 1) return null;
  const state = states.size ? [...states][0] : null;
  if (state) {
    const supported = state === 'overdue' ? info.states.overdue : state === 'due_today' ? info.states.dueToday
      : state === 'expiring' ? info.states.expiring : info.states.open;
    if (!supported) return null;
    if (state === 'expiring') {
      // Its window, when one was written ("expiring this month"); two different ones conflict.
      const ranges = uniq(of('state').flatMap((s) => (s.range ? [s.range] : [])));
      if (ranges.length > 1) return null;
      expiring = { op: 'state', v: 'expiring', ...(ranges.length ? { range: ranges[0] } : {}) };
      where.push(expiring);
    } else {
      where.push({ op: 'state', v: state });
    }
    keys.add('status');
  }
  if (stages.length) {
    if (!info.stageField) return null;
    where.push(stages.length === 1 ? { f: info.stageField, op: 'eq', v: stages[0] } : { f: info.stageField, op: 'in', v: stages });
    keys.add('status');
  }
  if (outcomes.length) {
    if (outcomes.length > 1 || stages.length) return null;
    where.push({ op: 'outcome', v: outcomes[0] });
    keys.add('status');
  }
  // "open and won deals", "paid and overdue invoices": an open (overdue, due
  // today) record is never in a finished stage, and a closed one never in an
  // unfinished one, so together they name nothing; both sets were meant. One
  // such stage among others ("open, contacted and won leads", "closed
  // qualified and won leads") would be dropped without a word: refused too.
  // So is a stage an expiring record is never in ("draft contracts expiring
  // this month": only active contracts expire).
  if (state && (stages.length || outcomes.length)) {
    const named = info.stages.filter((s) => (stages.length ? stages.includes(s.key) : s.outcome === outcomes[0]));
    if (state === 'expiring' ? named.some((s) => !runsWhileExpiring(info, s)) : named.some((s) => s.terminal !== (state === 'closed'))) {
      return REFUSED;
    }
  }
  for (const [field, values] of enums) {
    if (values.length > 1 && isMultiSelect(info, field)) return null;
    where.push(values.length === 1 ? { f: field, op: 'eq', v: values[0] } : { f: field, op: 'in', v: values });
    keys.add('status');
  }
  for (const f of uniq(of('flag').map((x) => x.field))) {
    where.push({ f, op: 'eq', v: true });
    keys.add('status');
  }

  // "deals won last month", "work orders completed this week", "leads
  // contacted yesterday": the date is most likely when the record reached
  // that state, which no field here records; the record's own date would be
  // a wrong answer. A finished state with the module's default date, or a
  // stage or state right before it, is left to the planner; so is a
  // breakdown by that date ("won deals per month": by the month they were
  // created) and a finished state sorted by "latest" or "oldest" ("latest won
  // deals": the latest created). Calls and meetings are the exception: their
  // default date is when the call or meeting itself happens ("missed calls
  // yesterday").
  const finished = state === 'closed' || outcomes.length > 0
    || stages.some((key) => info.stages.some((s) => s.key === key && s.terminal));
  const defaultDated = (it: V1Item): boolean => (it.t === 'date' && it.sel === 'default')
    || (it.t === 'group' && !it.field && (it.sel ?? 'default') === 'default');
  if (!isEventDated(info)) {
    if (finished && (items.some(defaultDated) || sorts.some((s) => s.target.kind === 'created'))) return REFUSED;
    const meaningful = items.filter((it) => it.t !== 'filler');
    for (let k = 1; k < meaningful.length; k += 1) {
      const prev = meaningful[k - 1].t;
      if (defaultDated(meaningful[k]) && (prev === 'stage' || prev === 'state' || prev === 'outcome')) return REFUSED;
    }
  }

  const dateFields = new Set<string>();
  for (const d of dates) {
    // "expiring contracts this month": a date written alone is the expiring
    // window, never the module's own default date (a contract's start, a
    // quotation's creation): one from today on where no window was written
    // after "expiring"; any other is the planner's ("expiring contracts in
    // November", "expiring contracts last month").
    if (expiring && d.sel === 'default' && !d.field) {
      if (expiring.range || d.value.kind !== 'within' || !EXPIRING_WINDOWS.has(d.value.rel)) return null;
      expiring.range = d.value.rel;
      continue;
    }
    const field = d.field ?? (d.sel === 'default' && bareDate !== undefined ? bareDate : dateFieldFor(info, d.sel));
    if (!field || !isDateUsable(info, field) || dateFields.has(field)) return null;
    if (state === 'due_today' && field === dueFieldOf(info)) return null;
    // "overdue invoices today", "overdue tasks tomorrow", "overdue invoices
    // next week": overdue is due before today, so a due date from today on
    // names nothing.
    if (state === 'overdue' && field === dueFieldOf(info) && allowsNoPastDay(d.value, ctx.todayKey)) return REFUSED;
    // "expiring" has its own window on that date: a second one would name two.
    if (state === 'expiring' && field === info.expiring?.field) return null;
    dateFields.add(field);
    where.push(dateCondition(field, d.value));
    keys.add('date');
  }

  if (amounts.length) {
    const field = info.amountField;
    if (!field || amounts.length > 2) return null;
    if (amounts.length === 2) {
      const lower = amounts.filter((a) => a.op === 'gt' || a.op === 'gte').length;
      const upper = amounts.filter((a) => a.op === 'lt' || a.op === 'lte').length;
      if (lower !== 1 || upper !== 1) return null;
    }
    const currencies = uniq(amounts.flatMap((a) => (a.currency ? [a.currency] : [])));
    if (currencies.length > 1) return null;
    // A Field Service amount has no currency of its own: it is in the
    // caller's (GrammarContext.fsCurrency). A written currency is believed
    // only when it is that one; when that isn't known (several currencies
    // and no branch) no written currency is.
    if (currencies.length === 1 && !info.amountCurrencyField && currencies[0] !== ctx.fsCurrency) return null;
    for (const a of amounts) where.push({ f: field, op: a.op, v: a.v } as Cond);
    // A currency written next to a deal amount keeps the comparison in that currency.
    if (currencies.length === 1 && info.amountCurrencyField) where.push({ f: info.amountCurrencyField, op: 'eq', v: currencies[0] });
    keys.add('amount');
  }

  // "or" only joins two values of one field ("new or contacted leads", "hot
  // or warm leads this month"); anything else it joins is a question this
  // grammar doesn't read ("hot or overdue leads").
  const plain = items.filter((it) => it.t !== 'filler');
  const sameField = (a: V1Item | undefined, b: V1Item | undefined): boolean => !!a && !!b && (
    (a.t === 'stage' && b.t === 'stage') || (a.t === 'enum' && b.t === 'enum' && a.field === b.field));
  if (plain.some((it, k) => it.t === 'or' && !sameField(plain[k - 1], plain[k + 1]))) return null;
  return { where, keys, state, amounts: amounts.length };
}

/** Where a date written alone goes for a named metric (METRIC_BARE_DATES):
 * its own date, the module's due date, or nowhere (null: not read). */
function metricBareDate(info: GrammarModuleInfo, metric: MetricDef): string | null {
  const rule = hasOwn(METRIC_BARE_DATES, metric.key) ? METRIC_BARE_DATES[metric.key] : undefined;
  if (rule === 'metric') return metric.dateField ?? null;
  return rule === 'due' ? info.dates.due ?? null : null;
}

/** A named metric right before its module's name ("outstanding invoices",
 * "billed invoices"): those records, not their total. */
function metricBeforeModule(items: readonly V1Item[]): boolean {
  const plain = items.filter((it) => it.t !== 'filler');
  return plain.some((it, k) => it.t === 'metric' && plain[k + 1]?.t === 'module');
}

/** "customers by purchase amount" (the breakdown's module named first): only
 * "show", "compare", "rank" or "top N" before it, and the metric right after
 * it. Anything else before it would say which customers ("my customers",
 * "active customers by outstanding"), which a total of the metric's own
 * records doesn't take. */
function firstBreakdownPlaced(items: readonly V1Item[]): boolean {
  const plain = items.filter((it) => it.t !== 'filler');
  const k = plain.findIndex((it) => it.t === 'per' && it.first);
  return k < 0 || (plain.slice(0, k).every((it) => it.t === 'list' || it.t === 'rank' || it.t === 'top') && plain[k + 1]?.t === 'metric');
}

/** What only a pipeline word leaves out: anything else that shapes or draws the answer. */
const NOT_WITH_PIPELINE: ReadonlySet<V1Item['t']> = new Set<V1Item['t']>(['group', 'sort', 'top', 'per', 'rank', 'count', 'much', 'breakdown', 'present']);

/** A module whose stages are a tenant pipeline (PIPELINE_MODULES), counted
 * per stage on executor Q (Increment 8). */
function hasPipeline(info: GrammarModuleInfo): info is GrammarModuleInfo & { stageField: string } {
  const stage = info.stageField;
  return !info.custom && info.q && !!stage && PIPELINE_MODULES.includes(info.key)
    && info.groupable.some((f) => f.key === stage && !DATE_KINDS.has(f.kind));
}

/** "deal pipeline", "deals kanban", "pipeline of my deals", "sales funnel"
 * (Increment 8): one pipeline word right after the module's name, or before
 * "of" and the module's name, or a phrase that names the module itself, on a
 * module with a pipeline (hasPipeline), with nothing else shaping or drawing
 * the answer. Filters, "mine" and relations keep their meaning ("open deals
 * pipeline", "my deal pipeline"); "deals in the pipeline" is not read. */
function pipelineNamed(items: readonly V1Item[], info: GrammarModuleInfo): boolean {
  if (!hasPipeline(info)) return false;
  if (items.some((it) => NOT_WITH_PIPELINE.has(it.t)) || items.filter((it) => it.t === 'pipeline').length !== 1) return false;
  const at = items.findIndex((it) => it.t === 'pipeline');
  const word = items[at];
  if (word.t === 'pipeline' && word.module) return !items.some((it) => it.t === 'module');
  if (items[at - 1]?.t === 'module') return true;
  const next = items[at + 1];
  return next?.t === 'filler' && next.w === OF_WORD && items.slice(at + 2).some((it) => it.t === 'module');
}

/** What readTarget took out of the message for one reading: a relation (and
 * the other module it touches) or a Custom Module's text search. */
interface ReadExtras {
  relation?: NonNullable<QueryPlan['relation']>;
  related?: string;
  search?: string;
}

/** A reading, the words that named its module (ambiguousModule), whether that
 * module is one of the tenant's Custom Modules, whether its module was named
 * by a word that also names a module of the other kind (a built-in module and
 * a Custom Module: "equipment"), and whether it uses something only its
 * module has (`own`, ownsReading), so the other module can't have been meant. */
interface Reading { parse: GrammarParse; words: string; custom: boolean; collides: boolean; own: boolean }

/** What only the reading's module has: for a Custom Module, one of its own
 * fields named by a value or a label ("pump equipment", "paid site visits",
 * "visit date this week", "equipment by kind"); for a built-in module, one of
 * its stage or enum values ("retired equipment"), or what a Custom Module
 * never has: "mine" ("how many customers do I have"; its records have no
 * owner). A date, the creation date or a plain list is any module's
 * ("equipment this month"). */
function ownsReading(items: readonly V1Item[], info: GrammarModuleInfo, mine: MineMode | undefined): boolean {
  const custom = info.custom;
  if (!custom) return !!mine || items.some((it) => it.t === 'stage' || it.t === 'outcome' || it.t === 'enum');
  const ownField = (key: string | undefined): boolean => !!key && custom.fields.some((f) => f.key === key);
  return items.some((it) => it.t === 'enum' || it.t === 'flag' || (it.t === 'date' && ownField(it.field))
    || (it.t === 'group' && ownField(it.field)) || (it.t === 'sort' && it.target.kind === 'field' && ownField(it.target.key)));
}

/** One reading of `toks` (the message, or what readTarget left of it) as a
 * read of `info`'s module, with `extras`: null, or REFUSED (see there). */
function readCore(toks: readonly WordToken[], ctx: GrammarContext, info: GrammarModuleInfo, extras: ReadExtras = {}): Reading | Refused | null {
  const vocab = vocabFor(ctx, info);
  let items = segmentV1(toks, vocab, info, ctx.todayKey);
  // "I" before anything but what the caller wants to see or a "mine" phrase
  // ("tasks I need to do", "deals I have to close": their own work), "be"
  // ("invoices to be paid"), and an agenda question.
  if (items.some((it) => it.t === 'word' && (it.w === I_WORD || V1_NOT_FILLERS.has(it.w))) || isAgenda(items)) return REFUSED;
  if (items.some((it) => it.t === 'word' || it.t === 'ambiguous')) return null;
  // "to do tasks": a name of the module that is also one of its stage or
  // enum values (the task synonym "to-do", the stage To Do) is that value
  // when the module is named again.
  const valueOf = (it: V1Item): V1Item | undefined => (it.t === 'module' && it.key === info.key ? vocab.values.get(it.words.join(' ')) : undefined);
  const named = items.filter((it) => it.t === 'module');
  if (named.length > 1 && named.some((it) => !valueOf(it))) items = items.map((it) => valueOf(it) ?? it);
  const of = <T extends V1Item['t']>(t: T): Array<ItemOf<T>> => items.filter((it): it is ItemOf<T> => it.t === t);

  const module = info.key;
  const custom = info.custom;
  const moduleItems = of('module');
  const metricItems = of('metric');
  const pipelines = of('pipeline');
  // A named metric names its module's records itself ("outstanding per customer"), as "sales pipeline" names the deals.
  const selfNamed = metricItems.length > 0 || pipelines.some((p) => p.module === module);
  if ((!moduleItems.length && !selfNamed) || moduleItems.some((m) => m.key !== module)
    || pipelines.some((p) => p.module !== undefined && p.module !== module)) return null;
  const sources = uniq(of('source').map((s) => s.source));
  // A Custom Module is in no sidebar group of the registry's: a source qualifier names something else.
  const group = custom ? undefined : ctx.groupOf(module);
  if (custom ? sources.length > 0 : !group || sources.length > 1 || (sources.length === 1 && sources[0] !== group)) return null;
  const mine = mineOf(items, info);
  if (mine === null || mine === REFUSED) return mine;
  // Custom Module records have no owner: executor M never narrows them to the caller's.
  if (mine && custom) return null;

  const sorts = of('sort');
  const tops = of('top');
  const groups = of('group');
  const pers = of('per');
  const ranks = of('rank');
  const counts = of('count');
  const presents = of('present');
  const filtered = items.some((it) => isValueItem(it) || it.t === 'date' || it.t === 'amount');
  const shaped = sorts.length + tops.length + groups.length > 0;
  const metricKeys = uniq(metricItems.map((m) => m.key));
  const metric = metricKeys.length === 1 ? metricFor(module, metricKeys[0]) : undefined;
  const asks = extras.relation !== undefined || extras.search !== undefined;
  // One way to draw it ("chart of ... as a table": which one?).
  if (presents.length > 1) return null;

  let op: 'list' | 'count' | 'aggregate';
  if (metricItems.length) {
    // A named metric (Increment 5): its total, or one row per value of its breakdown.
    if (!metric || pipelines.length) return null;
    op = 'aggregate';
  } else if (pipelines.length) {
    // "deal pipeline", "funnel of leads", "sales pipeline" (Increment 8): the module counted per stage of its pipeline.
    if (!pipelineNamed(items, info)) return null;
    op = 'aggregate';
  } else if (pers.length || ranks.length || of('much').length) {
    return null; // "per customer", "compare", "how much": a total of nothing named
  } else if (groups.length) op = 'aggregate';
  else if (counts.length) op = 'count';
  // "my leads", "customers with invoices", "open tickets as a table" ask for them
  else if (of('list').length || filtered || shaped || mine || asks || presents.length) op = 'list';
  else return null; // a bare module name may answer the existing assistant's own question
  if (metric) {
    // A total is never counted ("how many outstanding invoices"), sorted, or
    // compared by amount. It is broken down by its own field ("per customer",
    // "pipeline value by stage") or, where it has one, by its own date
    // ("payments received per month", "won value per quarter"; Increment 8),
    // never by both or anything else. It is ranked ("top 5 customers by
    // outstanding", "compare customers by purchase amount": decision D10) only
    // by its field.
    if (sorts.length || of('amount').length || of('breakdown').length) return null;
    const g = groups[0];
    if (groups.length > 1 || (g && pers.length)) return null;
    if (g && (g.field ? !metric.groupBy.includes(g.field) : !metric.bucketField || (g.sel ?? 'default') !== 'default')) return null;
    if (((tops.length || ranks.length) && !pers.length && !g?.field) || tops.length > 1 || !firstBreakdownPlaced(items)) return null;
    if (counts.some((c) => c.w !== TOTAL_WORD)) return null;
    if (uniq(pers.map((p) => p.by)).length > 1 || pers.some((p) => !metric.groupBy.includes(p.by))) return null;
    if (metricBeforeModule(items)) return null;
    // "invoiced" alone may answer the assistant's own question.
    if (metricItems.every((m) => m.context) && !(pers.length || groups.length || of('much').length || counts.length || filtered || mine || asks)) return null;
  } else {
    if (groups.length > 1 || sorts.length > 1 || tops.length > 1) return null;
    if (of('breakdown').length && !groups.length) return null;
    if (op !== 'list' && (sorts.length || tops.length)) return null;
  }
  // Filters, sorts, breakdowns and "mine" run on executor Q only (pipelines too: hasPipeline).
  if ((filtered || shaped || mine) && !info.q) return null;

  if (getsValue(items)) return REFUSED;
  // "expenses total this month", "the total of overdue invoices": a sum of the
  // module's amounts, which isn't read here. "total" alone counts only before
  // what it counts ("total overdue invoices"; "how many invoices in total").
  // Not REFUSED: grammar v0 has counted a plain "expenses total" since Increment 1.
  // A named metric is the sum it names ("total outstanding", "invoice total").
  if (!metric && info.amountField && counts.length && counts.every((c) => c.w === TOTAL_WORD)) {
    const firstModule = items.findIndex((it) => it.t === 'module');
    const sum = (it: V1Item, k: number): boolean => {
      if (it.t !== 'count') return false;
      const next = items[k + 1];
      return k > firstModule || (next?.t === 'filler' && next.w === OF_WORD);
    };
    if (items.some(sum)) return null;
  }

  const conds = conditionsOf(items, ctx, info, metric ? metricBareDate(info, metric) : undefined);
  if (conds === null || conds === REFUSED) return conds;
  const { where, keys, state } = conds;

  let sort: { by: string; dir: 'asc' | 'desc' } | undefined;
  let pageSize: number | undefined;
  const s = sorts[0];
  const top = tops[0];
  if (top && s?.n !== undefined) return null;
  const n = top?.n ?? s?.n;
  // A list shows one page of N; a named metric's breakdown keeps its N largest
  // rows (plan.top, which QueryPlanSchema caps at 50).
  if (n !== undefined && !metric) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOP) return null;
    pageSize = n;
  }
  if (s) {
    const resolved = resolveSort(info, s.target, s.dir);
    if (!resolved) return null;
    if (resolved !== 'default') sort = resolved;
    keys.add('sort');
  } else if (top && metric) {
    keys.add('sort');
  } else if (top) {
    const amount = amountSort(info, 'desc');
    if (!amount) return null; // "top 5 tasks": top by what?
    sort = amount;
    keys.add('sort');
  } else if (op === 'list' && state === 'overdue') {
    const due = dueFieldOf(info);
    if (due && isSortable(info, due)) sort = { by: due, dir: 'asc' };
  } else if (op === 'list' && state === 'expiring') {
    // The soonest to expire first.
    const end = info.expiring?.field;
    if (end && isSortable(info, end)) sort = { by: end, dir: 'asc' };
  } else if (op === 'list' && conds.amounts) {
    sort = amountSort(info, 'desc') ?? undefined;
  }

  let groupBy: { by: string; bucket?: Bucket } | undefined;
  if (groups.length) {
    const g = groups[0];
    if (g.field) {
      if (!info.groupable.some((f) => f.key === g.field && !DATE_KINDS.has(f.kind))) return null;
      groupBy = { by: g.field };
    } else {
      // A named total by date is by its own date (MetricDef.bucketField: "payments received per month").
      const field = metric ? metric.bucketField : dateFieldFor(info, g.sel ?? 'default');
      if (!field || !g.bucket || !info.groupable.some((f) => f.key === field && DATE_KINDS.has(f.kind))) return null;
      // "expiring contracts per month": by the month they expire, or started? Their window is the expiring one.
      if (state === 'expiring') return null;
      groupBy = { by: field, bucket: g.bucket };
    }
    keys.add('group');
  } else if (pers.length) {
    groupBy = { by: pers[0].by };
    keys.add('group');
  } else if (pipelines.length && hasPipeline(info)) {
    groupBy = { by: info.stageField };
  }
  // How it is drawn (Increment 8): a pipeline word draws the pipeline; a kind
  // as named; "chart" alone the kind that fits: horizontal bars for a named
  // total by its field (a ranking), none for a breakdown by date (the composer
  // draws a line or bars by the number of points), bars for anything else
  // (the composer says what it shows instead for a list or a number).
  let present: Present | undefined;
  if (pipelines.length) present = 'pipeline';
  else if (presents.length) {
    const word = presents[0].v;
    present = word !== 'chart' ? word : groupBy?.bucket ? undefined : metric && groupBy ? 'hbar' : 'bar';
  }
  if (pipelines.length || presents.length) keys.add('present');
  if (mine) keys.add('mine');
  if (metric) keys.add('metric');
  if (extras.relation) keys.add('relation');
  if (extras.search !== undefined) keys.add('search');
  // Names of the other kind: the Custom Modules' for a built-in module, the registry's for a Custom Module.
  const otherKind = new Set(synonymWords(ctx).flatMap((s) => (!!s.custom !== !!custom ? [s.words.join(' ')] : [])));
  const reading = (parse: GrammarParse): Reading => ({
    parse, words: moduleItems[0]?.words.join(' ') ?? '', custom: !!custom,
    collides: moduleItems.some((m) => otherKind.has(m.words.join(' '))), own: ownsReading(items, info, mine),
  });

  // "how many customers (do we have)", "how many customers do I have": every
  // source counted on its own (D1).
  if (module === 'customer' && op === 'count' && !where.length && !sources.length && !sort && pageSize === undefined && !extras.relation
    && moduleItems.every((m) => m.words.length === 1 && CUSTOMER_CONCEPT_WORDS.has(m.words[0]))) {
    return reading(conceptCount(mine, present));
  }

  const plan: QueryPlan = {
    v: 1, op, target: { module },
    ...(where.length ? { where } : {}),
    ...(mine ? { mine } : {}),
    ...(extras.search !== undefined ? { search: extras.search } : {}),
    ...(extras.relation ? { relation: extras.relation } : {}),
    ...(metric
      ? { metrics: [{ metric: metric.key }], ...(groupBy ? { group: groupBy } : {}), ...(top ? { top: top.n } : {}) }
      : groupBy ? { group: groupBy, metrics: [{ fn: 'count' as const }] } : {}),
    ...(sort ? { sort } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(present ? { present } : {}),
  };
  if (!QueryPlanSchema.safeParse(plan).success) return null;
  return reading({
    kind: 'read', op, module, modules: extras.related ? [module, extras.related] : [module], filterKeys: [...keys].sort(),
    ...(sources.length === 1 ? { source: sources[0] } : {}),
    plan,
  });
}

/* ── Relations and searches (Increment 5) ──────────────────────────────── */

/** What may stand on the related side of "customers with overdue invoices":
 * the related module's name, its own conditions, "or" between two of its
 * values, and fillers. */
const CHILD_ITEMS: ReadonlySet<V1Item['t']> = new Set<V1Item['t']>(['module', 'state', 'stage', 'outcome', 'enum', 'date', 'amount', 'or', 'filler']);
/** contracts/plan.ts: a relation has at most this many conditions of its own. */
const MAX_RELATION_WHERE = 5;

/** The related side of a has / has_none relation: the module named after the
 * phrase, related to the target that way in registry/relations.ts, with its
 * own conditions read with its own words ("customers with overdue invoices":
 * invoices, overdue). A module the caller can't read is named, never
 * filtered (the answer then says it can't be seen). `implied`: the phrase
 * named it ("customers never invoiced"). */
function readChild(
  toks: readonly WordToken[], ctx: GrammarContext, target: string, kind: HasKind, implied?: string,
): { child: string; where: Cond[] } | Refused | null {
  if (implied) return relationFor(target, kind, implied) && toks.every((_, k) => isV1FillerAt(toks, k)) ? { child: implied, where: [] } : null;
  const found: Array<{ child: string; where: Cond[] }> = [];
  let refused = false;
  for (const child of registryModulesIn(toks, ctx)) {
    if (!relationFor(target, kind, child)) continue;
    const info = ctx.moduleInfo?.(child);
    const where = info && info.key === child ? childConditions(toks, ctx, info) : namedOnly(toks, ctx, child);
    if (where === REFUSED) refused = true;
    else if (where) found.push({ child, where });
  }
  if (refused) return REFUSED;
  return found.length === 1 ? found[0] : null;
}

/** The related module's name with its own conditions, or null when the words are anything else. */
function childConditions(toks: readonly WordToken[], ctx: GrammarContext, info: GrammarModuleInfo): Cond[] | Refused | null {
  const items = segmentV1(toks, vocabFor(ctx, info), info, ctx.todayKey);
  if (items.some((it) => it.t === 'word' && (it.w === I_WORD || V1_NOT_FILLERS.has(it.w)))) return REFUSED;
  if (items.some((it) => it.t === 'word' || it.t === 'ambiguous')) return null;
  if (getsValue(items)) return REFUSED;
  if (items.some((it) => !CHILD_ITEMS.has(it.t) || (it.t === 'module' && it.key !== info.key))) return null;
  // "customers with more than 2 invoices" counts invoices: no amount before the module's name.
  const at = items.findIndex((it) => it.t === 'module');
  if (at < 0 || items.slice(0, at).some((it) => it.t === 'amount')) return null;
  if (!info.q && items.some((it) => it.t !== 'module' && it.t !== 'filler')) return null;
  const conds = conditionsOf(items, ctx, info);
  if (conds === null || conds === REFUSED) return conds;
  return conds.where.length <= MAX_RELATION_WHERE ? conds.where : null;
}

/** The related module's name and fillers only. */
function namedOnly(toks: readonly WordToken[], ctx: GrammarContext, child: string): Cond[] | null {
  const names = synonymWords(ctx).filter((s) => s.key === child && !s.custom);
  let named = false;
  for (let i = 0; i < toks.length;) {
    const hit = longestWords(names.filter((s) => wordsAt(toks, i, s.words)).map((s) => s.words));
    if (hit) { named = true; i += hit.length; } else if (isV1FillerAt(toks, i)) i += 1;
    else return null;
  }
  return named ? [] : null;
}

function longestWords(found: ReadonlyArray<readonly string[]>): readonly string[] | undefined {
  return found.reduce<readonly string[] | undefined>((best, w) => (!best || w.length > best.length ? w : best), undefined);
}

/** The registry modules (never a Custom Module) whose names stand in the words. */
function registryModulesIn(toks: readonly WordToken[], ctx: GrammarContext): string[] {
  const out: string[] = [];
  for (const s of synonymWords(ctx)) {
    if (s.custom || out.includes(s.key)) continue;
    for (let i = 0; i + s.words.length <= toks.length; i += 1) {
      if (wordsAt(toks, i, s.words)) { out.push(s.key); break; }
    }
  }
  return out;
}

/** The message as readTarget reads it: its tokens, the same as words (a
 * record number is a word no phrase reads, "#<number>"), where each was
 * written (tokens.ts tokenizeV1Spans) and its quoted parts. */
interface Source {
  tokens: readonly Token[];
  words: readonly WordToken[];
  spans: ReadonlyArray<TokenSpan | null>;
  text: string;
  quotes: readonly TokenSpan[];
}

/** A name or a search as written: at most this many characters (contracts/plan.ts). */
const MAX_NAME_TEXT = 100;

function hasNumber(src: Source, from: number, to: number): boolean {
  return src.tokens.slice(from, to).some((t) => t.kind === 'number');
}

/** One word no part of the target's own reads: an unknown word or a filler. */
function isLoose(seg: Seg | undefined): seg is Seg {
  return !!seg && seg.len === 1 && (seg.item.t === 'word' || seg.item.t === 'filler');
}

/** A word that can start a name: it has a letter and isn't a stop word ("me", "next", "all"). */
function startsName(t: WordToken | undefined): boolean {
  return !!t && t.num === undefined && !t.iso && !t.w.startsWith('#') && /\p{L}/u.test(t.w) && !NAME_STOP_WORDS.has(t.w);
}

const inside = (span: TokenSpan | null | undefined, quote: TokenSpan): boolean => !!span && span[0] >= quote[0] && span[1] <= quote[1];

/** Words as written ([from, end) of the message), without double quotes (a
 * name quoted only in part: the "ABC" Industries), spaces made single. */
function writtenText(src: Source, from: number, end: number): string {
  const a = src.spans[from];
  const b = src.spans[end - 1];
  const raw = a && b ? src.text.slice(a[0], b[1]) : src.words.slice(from, end).map((t) => t.w).join(' ');
  return raw.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "for Rs 5000", "for AED 5000": an amount at src.words[at] (a currency,
 * then a number), never the start of a name. */
function amountAt(src: Source, at: number): boolean {
  return !!matchMoney(src.words, at)?.currency || (NAME_CURRENCY_CODES.has(src.words[at]?.w ?? '') && src.words[at + 1]?.num !== undefined);
}

/** A name (or a search) written from segs[k] on, as [from, end) of the
 * message and its text as written: quoted text whole, whatever its words;
 * else the words no other part of the target reads, other modules' names
 * among them ("Kumar Services"), up to a word that ends a name
 * (NAME_END_WORDS), without an article before them (NAME_ARTICLES; any other
 * filler there means no name) or fillers after them. At most MAX_NAME_WORDS
 * words, the first one able to start a name (startsName), neither an amount
 * (amountAt) nor a field of the target (`vocab`'s labels, NAME_FIELD_NOUNS:
 * "invoices of status paid"). `segs`: the unquoted name's items, [b, e). */
function nameAt(src: Source, segs: readonly Seg[], k: number, target: string, vocab: ModuleVocab):
  { from: number; end: number; text: string; segs?: readonly [number, number] } | null {
  const first = segs[k];
  if (!first) return null;
  const quote = src.quotes.find((q) => inside(src.spans[first.at], q));
  if (quote) {
    // Only a quote that starts here: "for "ABC Industries"", not one opened earlier.
    if (first.at > 0 && inside(src.spans[first.at - 1], quote)) return null;
    let end = first.at;
    while (end < src.tokens.length && inside(src.spans[end], quote)) end += 1;
    const text = src.text.slice(quote[0], quote[1]).replace(/\s+/g, ' ').trim();
    return end - first.at <= MAX_NAME_WORDS && text && text.length <= MAX_NAME_TEXT ? { from: first.at, end, text } : null;
  }
  const nameItem = (seg: Seg): boolean => (seg.item.t === 'module' ? seg.item.key !== target
    : isLoose(seg) && src.tokens[seg.at].kind === 'word' && !NAME_END_WORDS.has(src.words[seg.at].w));
  let e = k;
  while (e < segs.length && nameItem(segs[e])) e += 1;
  // "for ABC not paid", "for ABC Industries are not paid", "named Acme other
  // than planned", "for ABC partially paid": a negation or a degree word in the
  // name or right after it (fillers included) means the stage after it is not
  // what was asked, so there is no name here at all (NAME_NEGATION_WORDS).
  for (let x = k; x <= e && x < segs.length; x += 1) {
    const w = src.words[segs[x].at].w;
    if (isLoose(segs[x]) && (NAME_NEGATION_WORDS.has(w) || wordsAt(src.words, segs[x].at, OTHER_THAN))) return null;
  }
  let b = k;
  while (b < e && segs[b].item.t === 'filler' && NAME_ARTICLES.has(src.words[segs[b].at].w)) b += 1;
  while (e > b && segs[e - 1].item.t === 'filler') e -= 1;
  if (b >= e || segs[b].item.t !== 'word' || !startsName(src.words[segs[b].at]) || amountAt(src, segs[b].at)) return null;
  const from = segs[b].at;
  if (fieldPhraseAt(vocab, src.words, from) || NAME_FIELD_NOUNS.has(src.words[from].w)) return null;
  const end = segs[e - 1].at + segs[e - 1].len;
  const text = writtenText(src, from, end);
  return end - from <= MAX_NAME_WORDS && text && text.length <= MAX_NAME_TEXT ? { from, end, text, segs: [b, e] } : null;
}

/** "customers", "companies": a module named in its plural form, as its own
 * synonyms tell (they also hold "customer", "company"). */
function isPluralModule(ctx: GrammarContext, item: V1Item): boolean {
  if (item.t !== 'module') return false;
  const { words } = item;
  const last = words[words.length - 1] ?? '';
  const stems = [
    ...(last.endsWith('ies') ? [`${last.slice(0, -3)}y`] : []),
    ...(last.endsWith('es') ? [last.slice(0, -2)] : []),
    ...(last.endsWith('s') ? [last.slice(0, -1)] : []),
  ];
  return stems.length > 0 && synonymWords(ctx).some((syn) => syn.key === item.key && syn.words.length === words.length
    && syn.words.every((w, i) => (i === words.length - 1 ? stems.includes(w) : w === words[i])));
}

/** What a value phrase may be read as (a stage, state, outcome, enum value or
 * yes/no field, or a phrase that names two of them). */
const VALUE_ITEM_KINDS: ReadonlySet<V1Item['t']> = new Set<V1Item['t']>(['stage', 'state', 'outcome', 'enum', 'flag', 'ambiguous']);

/** A word the module reads alone as one of its values. */
function namesValue(vocab: ModuleVocab, w: string): boolean {
  return (vocab.byFirst.get(w) ?? []).some((p) => p.words.length === 1 && VALUE_ITEM_KINDS.has(p.item.t));
}

/** A word one of the caller's modules reads alone as one of its values
 * ("pending", "maintenance", "installation", "cash"), whichever module. */
function isValueWord(ctx: GrammarContext, w: string): boolean {
  for (const key of uniq(synonymWords(ctx).map((s) => s.key))) {
    const info = moduleInfoOf(ctx, key);
    if (info && namesValue(vocabFor(ctx, info), w)) return true;
  }
  return false;
}

/** With no parent module written ("for X", never "for customer X" or a
 * quoted "X"), an unquoted name that says when or what for, not whose: a
 * time first ("for the weekend", "for Q3", "for FY 2025"; NAME_TIME_WORDS),
 * or one word that names a purpose or a value of any of the caller's modules
 * ("for renewal", "for approval", "for maintenance"; decision D6). */
function whenOrWhat(src: Source, segs: readonly Seg[], [b, e]: readonly [number, number], ctx: GrammarContext): boolean {
  const first = src.words[segs[b].at].w;
  if (NAME_TIME_WORDS.has(first) || NAME_TIME_PATTERN.test(first)) return true;
  return e - b === 1 && (NAME_PURPOSE_WORDS.has(first) || isValueWord(ctx, first));
}

/** The parent named after "for" / "of" at segs[s] (FOR_WORDS): the record on
 * screen ("for this work order"), a record number ("for BADE2FF4-WO-0001"),
 * or a name ("for ABC Industries"). Its module is written before the name
 * ("for customer ABC"), else at its end ("for Alpha team"), else it is the
 * target's default parent (defaultParentFor: the customer, else the only
 * parent), and it must be a parent of the target (registry/relations.ts).
 * Words around a plural say which records, never whose name ("for customers
 * in Chennai", "for active customers"); only "customers named X" names one.
 * `end`: the first word after it. */
function entityAfter(src: Source, segs: readonly Seg[], s: number, info: GrammarModuleInfo, ctx: GrammarContext):
  { parent: string; entity: { text: string } | { focus: true }; end: number } | null {
  const target = info.key;
  const parentOf = (seg: Seg | undefined): string | undefined => (
    seg?.item.t === 'module' && seg.item.key !== target && relationFor(target, 'for', seg.item.key) ? seg.item.key : undefined);
  let k = s + 1;
  // "for this work order", "for that customer": the record on screen.
  if (isLoose(segs[k]) && FOCUS_WORDS.has(src.words[segs[k].at].w)) {
    const parent = parentOf(segs[k + 1]);
    return parent ? { parent, entity: { focus: true }, end: segs[k + 1].at + segs[k + 1].len } : null;
  }
  // "for (the) customer ABC", "for a customer named ABC".
  let j = k;
  while (segs[j]?.item.t === 'filler') j += 1;
  let parent: string | undefined;
  const lead = segs[j]?.item;
  if (lead?.t === 'module' && lead.key !== target) {
    parent = parentOf(segs[j]);
    if (!parent) return null;
    k = j + 1;
    if (isLoose(segs[k]) && NAMED_WORDS.has(src.words[segs[k].at].w)) k += 1;
    else if (isPluralModule(ctx, lead)) return null;
  }
  const at = segs[k]?.at;
  if (at === undefined) return null;
  // A record number, of the parent's module.
  const tok = src.tokens[at];
  if (tok.kind === 'number') {
    const module = hasOwn(BUSINESS_NUMBER_MODULES, tok.code) ? BUSINESS_NUMBER_MODULES[tok.code] : undefined;
    const p = parent ?? (module && relationFor(target, 'for', module) ? module : undefined);
    return p && module === p ? { parent: p, entity: { text: tok.number }, end: at + 1 } : null;
  }
  const name = nameAt(src, segs, k, target, vocabFor(ctx, info));
  if (!name) return null;
  let text = name.text;
  if (!parent && name.segs) {
    // "work orders for Alpha team": a name ending in a parent's own name names that parent.
    const [b, e] = name.segs;
    const p = e - 1 > b ? parentOf(segs[e - 1]) : undefined;
    if (p) {
      if (isPluralModule(ctx, segs[e - 1].item)) return null;
      let last = e - 1;
      while (last > b && segs[last - 1].item.t === 'filler') last -= 1;
      parent = p;
      text = writtenText(src, segs[b].at, segs[last - 1].at + segs[last - 1].len);
    }
  }
  // "work orders for the weekend", "contracts up for renewal": when or what for, not the default parent's name.
  if (!parent && name.segs && whenOrWhat(src, segs, name.segs, ctx)) return null;
  const p = parent ?? defaultParentFor(target);
  return p && relationFor(target, 'for', p) && text ? { parent: p, entity: { text }, end: name.end } : null;
}

/** Readings with a has / has_none relation taken out at each HAS_PHRASES
 * phrase no word of the target's own reads: the target before it, the
 * related module and its conditions after it. */
function hasReadings(src: Source, segs: readonly Seg[], ctx: GrammarContext, info: GrammarModuleInfo): Array<Reading | Refused | null> {
  const out: Array<Reading | Refused | null> = [];
  if (hasNumber(src, 0, src.tokens.length)) return out;
  for (const seg of segs) {
    if (!isLoose(seg)) continue;
    for (const p of HAS_PHRASES) {
      if (!wordsAt(src.words, seg.at, p.words)) continue;
      const side = readChild(src.words.slice(seg.at + p.words.length), ctx, info.key, p.kind, p.child);
      if (side === REFUSED || !side) {
        out.push(side);
        continue;
      }
      const relation = { kind: p.kind, name: side.child, ...(side.where.length ? { where: side.where } : {}) };
      out.push(readCore(src.words.slice(0, seg.at), ctx, info, { relation, related: side.child }));
    }
  }
  return out;
}

/** Readings with a "for" relation taken out at each FOR_WORDS word no word
 * of the target's own reads ("for this month" is a date). */
function forReadings(src: Source, segs: readonly Seg[], ctx: GrammarContext, info: GrammarModuleInfo): Array<Reading | Refused | null> {
  const out: Array<Reading | Refused | null> = [];
  if (!relationsTo(info.key).length) return out;
  segs.forEach((seg, s) => {
    if (!isLoose(seg) || !FOR_WORDS.has(src.words[seg.at].w)) return;
    const named = entityAfter(src, segs, s, info, ctx);
    if (!named || hasNumber(src, 0, seg.at) || hasNumber(src, named.end, src.tokens.length)) return;
    const relation = { kind: 'for' as const, name: named.parent, entity: named.entity };
    out.push(readCore([...src.words.slice(0, seg.at), ...src.words.slice(named.end)], ctx, info, { relation, related: named.parent }));
  });
  return out;
}

/** A Custom Module's readings with a text search taken out after each
 * SEARCH_PHRASES phrase ("site visits named Acme"). */
function searchReadings(src: Source, segs: readonly Seg[], ctx: GrammarContext, info: GrammarModuleInfo): Array<Reading | Refused | null> {
  const out: Array<Reading | Refused | null> = [];
  if (hasNumber(src, 0, src.tokens.length)) return out;
  for (const seg of segs) {
    if (!isLoose(seg)) continue;
    for (const p of SEARCH_PHRASES) {
      if (!wordsAt(src.words, seg.at, p)) continue;
      const k = segs.findIndex((x) => x.at === seg.at + p.length);
      const name = k < 0 ? null : nameAt(src, segs, k, info.key, vocabFor(ctx, info));
      if (name) out.push(readCore([...src.words.slice(0, seg.at), ...src.words.slice(name.end)], ctx, info, { search: name.text }));
    }
  }
  return out;
}

/** Every reading of the message as a read of `info`'s module: as it is,
 * with a relation taken out (hasReadings, forReadings) or, for a Custom
 * Module, a text search (searchReadings; a Custom Module never takes a
 * relation). Exactly one must work ("which customers have no invoices" read
 * at "have no" and at "no" is one reading), and one REFUSED refuses them all. */
function readTarget(src: Source, ctx: GrammarContext, info: GrammarModuleInfo): Reading | Refused | null {
  const segs = segmentSpans(src.words, vocabFor(ctx, info), info, ctx.todayKey);
  const results: Array<Reading | Refused | null> = [
    hasNumber(src, 0, src.tokens.length) ? null : readCore(src.words, ctx, info),
    ...(info.custom ? searchReadings(src, segs, ctx, info) : [...hasReadings(src, segs, ctx, info), ...forReadings(src, segs, ctx, info)]),
  ];
  if (results.includes(REFUSED)) return REFUSED;
  const readings = new Map<string, Reading>();
  for (const r of results) if (r && r !== REFUSED) readings.set(JSON.stringify(r.parse), r);
  return readings.size === 1 ? [...readings.values()][0] : null;
}

/* ── v1 connector counts ──────────────────────────────────────────────── */

type V1Outcome =
  /** reading: the one reading of a module it came from (none for a connector count or a choice of modules). */
  | { kind: 'parsed'; parse: GrammarParse; reading?: Reading }
  /** A vendor was named but the message is not a connector count this grammar reads. */
  | { kind: 'vendor'; type?: ConnectorType }
  /** A reading was refused on purpose (REFUSED): never answered by grammar v0 either. alone: a Custom
   * Module's reading refused only because its word also names a built-in module (parseV1), which
   * parseMessage offers next to grammar v0's plain read of that module (withCustomNamesake). */
  | { kind: 'refused'; alone?: Reading }
  | { kind: 'none' };

function vendorAt(toks: readonly Token[], i: number): { type: ConnectorType; len: number } | null {
  let best: { type: ConnectorType; len: number; everyday: boolean } | null = null;
  for (const p of CONNECTOR_PHRASES) {
    if ((!best || p.words.length > best.len) && wordsAt(toks, i, p.words)) best = { type: p.type, len: p.words.length, everyday: !!p.everyday };
  }
  // "how many people in our sales force": the sales team, not Salesforce.
  const before = toks[i - 1];
  if (best?.everyday && before?.kind === 'word' && VENDOR_DETERMINERS.has(before.w)) return null;
  return best && { type: best.type, len: best.len };
}

/** "how many Salesforce opportunities", "number of HubSpot companies", "how
 * many zoho sales orders": a vendor, a count, and either a deal or customer
 * word or the name of a stored module. Counts only; a connector list, a
 * filter, a second vendor, a passing mention of the vendor ("how many tickets
 * about hubspot"), a tense word ("did", "were"), a possessive ("their"),
 * "or", or "and" between two modules ("how many zoho sales orders and
 * invoices") is not read here. */
function connectorCount(toks: readonly Token[]): V1Outcome {
  const types: ConnectorType[] = [];
  const rest: Array<WordToken | null> = [];
  let hasCount = false;
  let hasSource = false;
  let mention = false;
  let hasOr = false;
  /** For each "and": how many vendors and words came before it. */
  const ands: number[] = [];
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (t.kind !== 'word') { rest.push(null); i += 1; continue; }
    if (t.w === OR_WORD) { hasOr = true; i += 1; continue; }
    if (t.w === AND_WORD) { ands.push(types.length + rest.length); i += 1; continue; }
    const vendor = vendorAt(toks, i);
    if (vendor) {
      const before = toks[i - 1];
      if (before?.kind === 'word' && VENDOR_MENTION_WORDS.has(before.w)) mention = true;
      types.push(vendor.type);
      i += vendor.len;
      continue;
    }
    const count = COUNT_PHRASES.find((p) => wordsAt(toks, i, p));
    if (count) { hasCount = true; i += count.length; continue; }
    const source = SOURCE_PHRASES.find((p) => wordsAt(toks, i, p.words));
    if (source) { hasSource = true; i += source.words.length; continue; }
    const filler = V1_FILLER_PHRASES.find((p) => wordsAt(toks, i, p));
    if (filler) { i += filler.length; continue; }
    if (COUNT_WORDS.has(t.w)) { hasCount = true; i += 1; continue; }
    // Stop words grammar v1 otherwise reads as fillers ("were", "was") are kept, so they refuse below.
    if (STORED_MODULE_STOP_WORDS.has(t.w) && !isReadFiller(t.w)) { rest.push(t); i += 1; continue; }
    if (isV1FillerAt(toks as WordToken[], i)) { i += 1; continue; }
    rest.push(t);
    i += 1;
  }
  if (!types.length) return { kind: 'none' };
  const distinct = uniq(types);
  if (distinct.length !== 1) return { kind: 'vendor' };
  const type = distinct[0];
  const refuse: V1Outcome = { kind: 'vendor', type };
  if (!hasCount || hasSource || mention || !rest.length) return refuse;
  // "and" with a vendor or module word on each side joins two things ("zoho
  // sales orders and invoices", "zoho and sales orders"); a leading or a
  // trailing one ("and how many zoho deals?") does not.
  const named = types.length + rest.length;
  if (hasOr || ands.some((n) => n > 0 && n < named)) return refuse;
  const words: string[] = [];
  for (const t of rest) {
    if (!t || t.num !== undefined || t.iso || t.glued) return refuse;
    if ((hasOwn(FILTER_WORDS, t.w) && !STORED_MODULE_NOUNS.has(t.w)) || STORED_MODULE_STOP_WORDS.has(t.w) || WRITE_VERBS.has(t.w)) return refuse;
    if (EXCLUDED_CONNECTOR_MODULES.has(t.w)) return refuse;
    words.push(t.w);
  }
  const concepts = words.filter((w) => hasOwn(CONNECTOR_CONCEPT_WORDS, w));
  const base = { op: 'count' as const, connector: type, modules: [`connector:${type}`], filterKeys: [] as string[] };
  if (words.length === 1 && concepts.length === 1) {
    return { kind: 'parsed', parse: { kind: 'connector_count', ...base, target: { concept: CONNECTOR_CONCEPT_WORDS[words[0]] } } };
  }
  // "deals and accounts", "deals native deals", "hubspot deal stages": a
  // deal or customer word with other words is not a stored module's name.
  if (concepts.length > 0) return refuse;
  const name = words.join(' ');
  if (name.length > MAX_STORED_MODULE_NAME || !STORED_MODULE_NAME_RE.test(name)) return refuse;
  return { kind: 'parsed', parse: { kind: 'connector_count', ...base, target: { storedModule: name } } };
}

/* ── v1 entry ─────────────────────────────────────────────────────────── */

/** A module's grammar info: one of the caller's Custom Modules
 * (customGrammarModuleInfo), else the registry module's (moduleInfo). */
function moduleInfoOf(ctx: GrammarContext, key: string): GrammarModuleInfo | undefined {
  const custom = ctx.customModules?.find((m) => m.key === key);
  if (custom) return customGrammarModuleInfo(custom);
  const info = ctx.moduleInfo?.(key);
  return info && info.key === key ? info : undefined;
}

let metricModuleWordsCache: ReadonlyArray<{ module: string; words: readonly string[] }> | null = null;

/** Every named metric's words, with the module it sums. */
function metricModuleWords(): ReadonlyArray<{ module: string; words: readonly string[] }> {
  metricModuleWordsCache ??= METRICS.flatMap((m) => metricWords(m).map((w) => ({ module: m.module, words: w.words })));
  return metricModuleWordsCache;
}

/** The modules the message may be a read of: those whose names stand in it
 * (the registry's and the caller's Custom Modules'), those a named metric
 * written in it sums ("payments received this month": receipts) and the deals
 * of "sales pipeline" (Increment 8; salesPipelineWords). */
function candidateTargets(toks: readonly Token[], ctx: GrammarContext): GrammarModuleInfo[] {
  const keys: string[] = [];
  const present = (words: readonly string[]): boolean => {
    for (let i = 0; i + words.length <= toks.length; i += 1) if (wordsAt(toks, i, words)) return true;
    return false;
  };
  for (const s of synonymWords(ctx)) if (!keys.includes(s.key) && present(s.words)) keys.push(s.key);
  for (const m of metricModuleWords()) if (!keys.includes(m.module) && present(m.words)) keys.push(m.module);
  if (!keys.includes(SALES_PIPELINE.module) && salesPipelineWords(ctx).some(present)) keys.push(SALES_PIPELINE.module);
  return keys.flatMap((key) => {
    const info = moduleInfoOf(ctx, key);
    return info ? [info] : [];
  });
}

/** Readings of one module word that names a built-in module and one of the
 * tenant's Custom Modules, or two Custom Modules ("equipment"): the same read
 * of each, offered as a choice (Increment 5). Other readings that all work
 * conflict (null). */
function ambiguousModule(readings: readonly Reading[]): GrammarParse | null {
  const words = readings[0]?.words;
  if (readings.length < 2 || !words || !readings.some((r) => r.custom)) return null;
  const choices: Array<{ module: string; op: 'list' | 'count' | 'aggregate'; plan: QueryPlan; filterKeys: string[] }> = [];
  for (const { parse: p, words: w } of readings) {
    if (w !== words || (p.kind !== 'read' && p.kind !== 'concept_count')) return null;
    choices.push({ module: p.kind === 'read' ? p.module : p.concept, op: p.op, plan: p.plan, filterKeys: p.filterKeys });
  }
  const op = choices[0].op;
  if (choices.some((c) => c.op !== op)) return null;
  const candidates = choices.map((c) => c.module);
  return {
    kind: 'ambiguous_module', op, candidates, plans: choices.map((c) => c.plan), modules: candidates,
    filterKeys: uniq(choices.flatMap((c) => c.filterKeys)).sort(),
  };
}

function parseV1(message: string, ctx: GrammarContext): V1Outcome {
  const spanned = tokenizeV1Spans(typeof message === 'string' ? message : '');
  const toks = spanned.tokens;
  if (!toks.length || toks.length > MAX_GRAMMAR_WORDS) return { kind: 'none' };
  const connector = connectorCount(toks);
  if (connector.kind !== 'none') return connector;
  // A business number is grammar v0's (a detail answer), or the parent a
  // "for" relation names ("invoices for BADE2FF4-WO-0001"; readTarget).
  const src: Source = {
    tokens: toks,
    words: toks.map((t): WordToken => (t.kind === 'word' ? t : { kind: 'word', w: `#${t.number}` })),
    spans: spanned.spans,
    text: spanned.text,
    quotes: quotedSpans(spanned.text),
  };
  const readings: Reading[] = [];
  let refused = false;
  for (const info of candidateTargets(toks, ctx)) {
    const reading = readTarget(src, ctx, info);
    if (reading === REFUSED) refused = true;
    else if (reading) readings.push(reading);
  }
  // A reading refused on purpose wins over any other; two readings that both
  // work are a conflict, unless one word named both modules (ambiguousModule).
  // A module named by a word that also names one of the other kind (a
  // built-in module and one of the caller's Custom Modules) is answered alone
  // only when the message uses something only that module has (Reading.own:
  // "pump equipment", "retired equipment", "how many customers do I have"),
  // never otherwise ("equipment this month", "show assets and equipment"; LD5).
  if (refused) return { kind: 'refused' };
  if (readings.length === 1) {
    const [only] = readings;
    if (only.collides && !only.own) return { kind: 'refused', ...(only.custom ? { alone: only } : {}) };
    return { kind: 'parsed', parse: only.parse, reading: only };
  }
  const choice = ambiguousModule(readings);
  return choice ? { kind: 'parsed', parse: choice } : { kind: 'none' };
}

/** Grammar v0's plain read of a module whose name, as written, is also the
 * name of one of the tenant's Custom Modules that grammar v1 read alone (the
 * built-in module isn't among the caller's): both, as a choice, never the
 * built-in one silently (LD5). */
function withCustomNamesake(
  v0: Extract<GrammarParse, { kind: 'read' }>, reading: Reading | undefined, ctx: GrammarContext, message: string,
): GrammarParse | null {
  const p = reading?.parse;
  if (!reading?.custom || !reading.words || p?.kind !== 'read' || p.op !== v0.op) return null;
  if (!ctx.synonyms.some((s) => s.key === v0.module && phraseWordsV1(s.phrase).join(' ') === reading.words)) return null;
  const concept = customerConceptOf(v0, message);
  const plan = concept && concept.kind === 'concept_count' ? concept.plan : v0.plan;
  return {
    kind: 'ambiguous_module', op: p.op, candidates: [v0.module, p.module], plans: [plan, p.plan], modules: [v0.module, p.module],
    filterKeys: uniq([...v0.filterKeys, ...p.filterKeys]).sort(),
  };
}

/** "how many customers" read by grammar v0 as a Field Service count becomes
 * the per-source customer concept count, unless the message names a source
 * ("field service customers"). */
function customerConceptOf(read: Extract<GrammarParse, { kind: 'read' }>, message: string): GrammarParse | null {
  if (read.module !== 'customer' || read.op !== 'count' || read.source || read.plan.where) return null;
  const words = phraseWords(message);
  if (words.includes('fieldservice')) return null;
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (words[i] === 'field' && (words[i + 1] === 'service' || words[i + 1] === 'services')) return null;
  }
  return words.some((w) => CUSTOMER_CONCEPT_WORDS.has(w)) ? conceptCount() : null;
}

/** Grammar v1's reading of a message grammar v0 reads plainly, when it is
 * that read narrowed: by a value whose word is also the module's name ("how
 * many to do tasks"), or to the caller's own records, whose words grammar v0
 * skips as fillers ("how many deals do I have", "how many customers do I
 * have"). */
function narrowsRead(v1: GrammarParse, v0: Extract<GrammarParse, { kind: 'read' }>): boolean {
  if (v1.kind === 'concept_count') return !!v1.plan.mine && v0.module === 'customer' && v0.op === 'count';
  return v1.kind === 'read' && v1.module === v0.module && v1.op === v0.op && (!!v1.plan.where?.length || !!v1.plan.mine);
}

/** "invoice total", "what is the invoice total": grammar v0 has counted these
 * since Increment 1, but they name the purchase amount, as "invoice totals"
 * and "invoice value" do (decision D5). Only a named metric of the module v0
 * counted, read from words v0 reads plainly, which only a metric phrase made
 * of the module's name and "total" can be (METRIC_PHRASES); "total
 * invoices", "the total of invoices" and "expenses total" stay counts. */
function sumsCount(v1: GrammarParse, v0: Extract<GrammarParse, { kind: 'read' }>): boolean {
  return v0.op === 'count' && v1.kind === 'read' && v1.module === v0.module && v1.op === 'aggregate'
    && !!v1.plan.metrics?.some((m) => 'metric' in m);
}

/** "draft quotations", "customers with draft quotations", "quotations in
 * draft status": grammar v0 reads "draft" as a create verb, but here it is
 * the Draft stage: it is the message's only write word, and each time it
 * stands right after "with" or "in", or right before the plural name of a
 * document the assistant never writes (DRAFT_DOCUMENTS). "draft invoices",
 * "draft a quotation" and "create draft quotations" stay writes. */
function draftNamesStage(message: string, ctx: GrammarContext): boolean {
  const tokens = tokenize(message);
  const verbs = tokens.flatMap((t, i) => (t.kind === 'word' && WRITE_VERBS.has(t.w) ? [{ i, w: t.w }] : []));
  return verbs.length > 0 && verbs.every(({ i, w }) => {
    if (w !== DRAFT_WORD) return false;
    const before = tokens[i - 1];
    if (before?.kind === 'word' && DRAFT_STAGE_AFTER.has(before.w)) return true;
    const named = phrasesFor(ctx).find((p) => p.item.t === 'module' && wordsAt(tokens, i + 1, p.words));
    return named?.item.t === 'module' && DRAFT_DOCUMENTS.has(named.item.key)
      && isPluralModule(ctx, { t: 'module', key: named.item.key, words: named.words });
  });
}

/** Bare "pipeline" ("pipeline", "show me the pipeline", "my pipeline", "our
 * pipeline", "open the pipeline"; Increment 8, decision N25): which one? Each
 * of the caller's modules with a pipeline is a choice, in PIPELINE_MODULES'
 * order, with its pipeline plan ("my": the caller's own records in each).
 * Only fillers and read verbs may stand around the word ("open" is the verb
 * here, never the open state); null when none of the caller's modules has a
 * pipeline. */
function barePipeline(message: string, ctx: GrammarContext): GrammarParse | null {
  const toks = tokenizeV1(message);
  if (!toks.length || toks.length > MAX_GRAMMAR_WORDS) return null;
  let named = 0;
  let mine: MineMode | undefined;
  for (const t of toks) {
    if (t.kind !== 'word' || t.num !== undefined) return null;
    if (BARE_PIPELINE_WORDS.has(t.w)) named += 1;
    else if (t.w === 'my') mine = 'assigned';
    else if (t.w !== OPEN_WORD && (!isReadFiller(t.w) || COUNT_WORDS.has(t.w))) return null;
  }
  if (named !== 1) return null;
  const choices = PIPELINE_MODULES.flatMap((module) => {
    const info = moduleInfoOf(ctx, module);
    if (!info || !hasPipeline(info)) return [];
    const plan: QueryPlan = {
      v: 1, op: 'aggregate', target: { module }, ...(mine ? { mine } : {}),
      group: { by: info.stageField }, metrics: [{ fn: 'count' }], present: 'pipeline',
    };
    return [{ module, plan }];
  });
  if (!choices.length) return null;
  const candidates = choices.map((c) => c.module);
  return {
    kind: 'ambiguous_module', op: 'aggregate', question: 'pipeline', candidates, plans: choices.map((c) => c.plan),
    modules: candidates, filterKeys: mine ? ['mine', 'present'] : ['present'],
  };
}

/** Parses one chat message. Small talk first (parseSmallTalk: greetings,
 * thanks, goodbyes, help). Then, with a grammar v0 context (no moduleInfo)
 * this is grammar v0 exactly. With a v1 context (loadGrammarContext) grammar
 * v0 runs first and keeps every answer it gives (plain lists and counts,
 * business numbers, write and configuration wording); only what v0 hands on
 * (needs_planner) is read by grammar v1, "how many customers" becomes the
 * per-source concept count, and a plain read that grammar v1 narrows
 * (narrowsRead: "how many to do tasks", "how many deals do I have") is read
 * with that filter or "mine". A plain read that grammar v1 refuses on purpose
 * ("show tasks I need to do", "how many tasks do I have to do": not every
 * task) goes to the existing assistant. A plain read of a module word that is
 * also the name of one of the tenant's Custom Modules ("show equipment") is
 * a choice of both (Increment 5). "invoice total" is the purchase amount
 * (sumsCount, decision D5), and "draft quotations" the Draft ones, not a
 * write (draftNamesStage). Before anything goes to the existing assistant
 * (Increment 8), bare "pipeline" asks which one (barePipeline) and a
 * question with no module may be the agenda ("what's on today", "what do we
 * need to do this week": parseAgenda, agenda.ts). */
export function parseMessage(message: string, ctx: GrammarContext): GrammarParse {
  const smallTalk = parseSmallTalk(message, ctx);
  if (smallTalk) return smallTalk;
  const v0 = parseV0(message, ctx);
  if (!ctx.moduleInfo) return v0;
  if (v0.kind === 'read') {
    const v1 = parseV1(message, ctx);
    if (v1.kind === 'refused') {
      // A Custom Module read alone for a word that also names v0's module: both, as a choice (LD5).
      return withCustomNamesake(v0, v1.alone, ctx, message) ?? parseAgenda(message, ctx)
        ?? legacy('needs_planner', v0.modules, v0.filterKeys);
    }
    if (v1.kind === 'parsed') {
      if (v1.parse.kind === 'ambiguous_module' && v1.parse.candidates.includes(v0.module)) return v1.parse;
      const both = withCustomNamesake(v0, v1.reading, ctx, message);
      if (both) return both;
      if (narrowsRead(v1.parse, v0) || sumsCount(v1.parse, v0)) return v1.parse;
    }
    return customerConceptOf(v0, message) ?? v0;
  }
  if (v0.kind !== 'legacy') return v0;
  // The Draft stage, not the verb: read as any other question (status is the key "draft" stands for).
  const handedOn = v0.reason === 'write' && draftNamesStage(message, ctx)
    ? legacy('needs_planner', v0.modules, uniq([...v0.filterKeys, 'status']).sort()) : v0;
  if (handedOn.kind !== 'legacy' || handedOn.reason !== 'needs_planner') return handedOn;
  const v1 = parseV1(message, ctx);
  if (v1.kind === 'parsed') return v1.parse;
  // A vendor's words are never reported as registry modules.
  if (v1.kind === 'vendor') return { ...handedOn, modules: v1.type ? [`connector:${v1.type}`] : [] };
  return barePipeline(message, ctx) ?? parseAgenda(message, ctx) ?? handedOn;
}
