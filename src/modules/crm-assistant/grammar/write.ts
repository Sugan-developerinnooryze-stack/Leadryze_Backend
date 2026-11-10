import { PLANNER_CAPS, RefInputSchema, WriteIntentSchema, WriteValueSchema } from '../contracts/plan';
import type { RefInput, WriteIntent, WriteValue } from '../contracts/plan';
import { FORM_CAPS } from '../contracts/views';
import { getModuleCap } from '../registry';
import type { WriteCap, WriteFieldKind, WriteFormField, WriteOp } from '../registry/types';
import { workflowModuleFor, writeCapFor } from '../writes/write-caps';
import { WORKFLOW_MODULE_KEYS } from '../writes/workflow-modules';
import type { FieldNote, FillField, FillFormSpec, FillParse, WriteParse } from '../writes/workflow-types';
import type { GrammarContext, GrammarModuleInfo } from './context';
import { MAX_GRAMMAR_WORDS } from './parse';
import type { GrammarParse } from './parse';
import {
  DateTimeMatch, DateTimeOptions, DateTimeSource, DateTimeValue, isDayKey, matchDateExpr, matchDateTimeAt, toWriteDate,
} from './dates';
import { matchMoney } from './numbers';
import {
  BUSINESS_NUMBER_MODULES, CREATE_VERBS, DELETE_VERBS, POLITE_PREFIX, Token, TokenSpan, UPDATE_VERBS, WordToken, phraseWordsV1,
  quotedSpans, tokenizeV1Spans,
} from './tokens';
import {
  ASSIGN_WORDS, CALL_DIRECTION_WORDS, CALL_STATUS_WORDS, CREATE_ARTICLES, FILL_CANCEL_PHRASES, FILL_REVIEW_PHRASES, FOCUS_WORDS,
  LINE_QTY_WORDS, MAX_NAME_WORDS, ME_WORD, NAME_ARTICLES, NAME_STOP_WORDS, NEW_WORD, OUTCOME_WORDS, PRIORITY_WORDS, STAGE_TAILS,
  TITLE_WORDS, VALUE_JOINERS, WRITE_FIELD_SYNONYMS, WRITE_FILLERS, WRITE_NAME_END, WRITE_TARGET_END, WriteFieldRole, YES_NO_WORDS,
} from './vocabulary';

/* The write grammar (Increment 6, spec B7): a create, update or delete the
 * staff member typed, read into a WriteIntent with no model call, and a typed
 * answer while a guided form is open, read into a fill, a cancel or a
 * review. Only a grammar v0 legacy 'write' parse comes here; parseMessage,
 * its v1 tables and what KEPT_WRITES pins are untouched. Pure: no reads (the
 * WriteCaps, WORKFLOW_MODULE_KEYS and the registry's labels are fixed tables)
 * and no clock beyond the grammar context's today, now and timezone.
 *
 * A request is read only where its module and its operation are certain:
 *  - after polite words ("please", "can you") comes a write verb;
 *  - a create names its module right after it ("create a task", "add a new
 *    lead"); an update or a delete names its record there: a record number,
 *    "this task", "task Call Ravi", or the module alone (the record on
 *    screen); "change the priority of <record> to high" names it after "of";
 *  - "new" before a plural, or with a date anywhere, asks for records ("new
 *    leads this week", L4); any other plural is uncertain (a form is for one
 *    record); a module without a guided form is not_workflow.
 * Then each part is read where it stands: the title, "for <name>", "with",
 * "assign to", a date-time (dates.ts), the priority, the status, ... The
 * words no part reads become notTaken: the form lists them and nothing
 * writes them (L3). Values are taken as written; the form checks each one.
 *
 * Increment 7 (spec B10.2): an operation a module answers with a notice
 * (WriteCap.refused: an invoice's or a quotation's delete) is read like any
 * other, so the notice comes with no model call. A create made from another
 * record (WorkflowModule.source: an invoice from a work order) names it as
 * "for <number>", "from work order <number>", "for this work order", or a
 * number right after the module; a document's create (WriteCap.lines) names
 * its catalog lines, "with 2 AC service and 1 filter", priced on the server. */

type ClockNote = 'am_pm' | 'midnight';
type Refs = Record<string, RefInput | RefInput[]>;
type From = NonNullable<WriteIntent['from']>;
type IntentLine = NonNullable<WriteIntent['lines']>[number];

const UNCERTAIN: WriteParse = { kind: 'uncertain' };
const NOT_WORKFLOW: WriteParse = { kind: 'not_workflow' };
const READ_LIKE: WriteParse = { kind: 'read_like' };

/** A text value's characters (a write value: contracts/plan.ts ScalarSchema) and a name's (RefInputSchema). */
const MAX_TEXT = 200;
const MAX_NAME_TEXT = 100;
/** One notTaken entry's characters (FormBlock.notTaken). */
const MAX_NOT_TAKEN_TEXT = 120;
/** Names in one list ("assign to Ravi and Kumar"): a WriteIntent ref list's most. */
const MAX_REFS = 10;
/** A WriteIntent's lines: at most 20, each quantity above 0 and at most 100,000 (contracts/plan.ts). */
const MAX_INTENT_LINES = 20;
const MAX_LINE_QTY = 100000;
/** The most of a message that is read: the characters the planner reads
 * (PLANNER_CAPS), as typed and as the tokens read them (NFKC makes some one
 * character several), and a request's tokens: grammar v0 hands on at most
 * MAX_GRAMMAR_WORDS words, and v1 makes a few of them more ("$5k" is three).
 * Past a cap the work would grow with the message, so none of it is read: a
 * request is uncertain (the planner's path, where a message longer than the
 * planner reads gets the "too long" answer and no model call), a typed
 * answer null. */
const MAX_MESSAGE_CHARS = PLANNER_CAPS.messageChars;
const MAX_REQUEST_TOKENS = MAX_GRAMMAR_WORDS * 2;
/** The title may follow "to" ("create a task to call Ravi"). */
const TO_TITLE_MODULES: ReadonlySet<string> = new Set(['task', 'workorder']);
/** The title or name may follow the module right away ("create a task call Ravi"); a work order's or an invoice's never. */
const BARE_TITLE_MODULES: ReadonlySet<string> = new Set([
  'task', 'ticket', 'activity', 'deal', 'customer', 'company', 'lead', 'contact',
  'quotation', 'category', 'service', 'part', 'product', 'asset', 'vehicle', 'expense', 'site', 'team', 'staff',
]);
/** Their title is a name: at most MAX_NAME_WORDS words, ended as a name is. */
const NAMED_MODULES: ReadonlySet<string> = new Set(['customer', 'company', 'lead', 'contact', 'category', 'site', 'team', 'staff']);
/** People: "from <company>" or "at <company>", and an email or a phone written anywhere. */
const PEOPLE_MODULES: ReadonlySet<string> = new Set(['lead', 'contact', 'customer', 'staff']);
/** "for Kumar Traders" is also the contact name (L22). */
const FOR_CONTACT_NAME_MODULES: ReadonlySet<string> = new Set(['ticket', 'call']);
/** "change the priority of ticket <number> to high". */
const FIELD_OF_VERBS: ReadonlySet<string> = new Set(['change', 'set', 'update', 'edit']);
/** An email and a phone as written (spec B7); a phone is never a day ("2026-11-05"). */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s-]{6,}\d/g;
/** The same two patterns, sticky, for reading one value at a known position
 * (rawAt). Literals, so no regex is built at run time; keep each one equal to
 * its pair above. */
const EMAIL_AT_RE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/y;
const PHONE_AT_RE = /\+?\d[\d\s-]{6,}\d/y;
const ISO_DAY_RE = /\d{4}-\d{2}-\d{2}/;

/* ── The message ──────────────────────────────────────────────────────────── */

/** A message as the write grammar reads it: tokenizeV1Spans' tokens, the same
 * as words (a record number is undefined there), where each was written and
 * its quoted parts. */
interface Source extends DateTimeSource {
  tokens: readonly Token[];
  quotes: readonly TokenSpan[];
}

/** The message as read, or null past MAX_MESSAGE_CHARS or `maxTokens`
 * (checked before its quotes are looked for). */
function sourceOf(message: string, maxTokens: number): Source | null {
  if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) return null;
  const { tokens, spans, text } = tokenizeV1Spans(message);
  if (tokens.length > maxTokens || text.length > MAX_MESSAGE_CHARS) return null;
  return { tokens, toks: tokens.map((t) => (t.kind === 'word' ? t : undefined)), spans, text, quotes: quotedSpans(text) };
}

const wordAt = (src: Source, k: number): string | undefined => src.toks[k]?.w;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const inside = (span: TokenSpan | null | undefined, quote: TokenSpan): boolean => !!span && span[0] >= quote[0] && span[1] <= quote[1];
const quoted = (src: Source, k: number): boolean => src.quotes.some((q) => inside(src.spans[k], q));
const single = <T>(list: readonly T[]): T | undefined => (list.length === 1 ? list[0] : undefined);

/** What is written between tokens k - 1 and k ("" where no place is known). */
function gapBefore(src: Source, k: number): string {
  const a = src.spans[k - 1];
  const b = src.spans[k];
  return k > 0 && a && b ? src.text.slice(a[1], b[0]) : '';
}

/** A ":" before token k ("Kumar Traders: AC not cooling"), not the one inside a clock time ("10:30"). */
function colonBefore(src: Source, k: number): boolean {
  const gap = gapBefore(src, k);
  return gap.includes(':') && !(gap === ':' && src.toks[k - 1]?.num !== undefined && src.toks[k]?.num !== undefined);
}

/** Tokens [from, end) as written, without double quotes, spaces made single. */
function writtenText(src: Source, from: number, end: number): string {
  const a = src.spans[from];
  const b = src.spans[end - 1];
  const raw = a && b ? src.text.slice(a[0], b[1]) : src.tokens.slice(from, end).map((t) => (t.kind === 'word' ? t.w : t.number)).join(' ');
  return raw.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The quote that starts at token k ("called "AC repair""): its text and the token after it. */
function quoteAt(src: Source, k: number): { end: number; text: string } | null {
  const quote = src.quotes.find((q) => inside(src.spans[k], q));
  if (!quote || (k > 0 && inside(src.spans[k - 1], quote))) return null;
  let end = k;
  while (end < src.tokens.length && inside(src.spans[end], quote)) end += 1;
  const text = src.text.slice(quote[0], quote[1]).replace(/\s+/g, ' ').trim();
  return text ? { end, text } : null;
}

/** A word that can start a name: it has a letter and isn't a stop word ("me", "next", "the"). */
function startsName(t: WordToken | undefined): boolean {
  return !!t && t.num === undefined && !t.iso && /\p{L}/u.test(t.w) && !NAME_STOP_WORDS.has(t.w);
}

/** A name written at k ("ABC Industries", "Kumar", "Call Ravi"): quoted text
 * whole; a record number alone; else, after an article, at most
 * MAX_NAME_WORDS words as written, the first able to start a name, up to a
 * word or part that ends it (`ends`), a ":" or a quote; at most 100
 * characters. */
function nameAt(src: Source, k: number, ends: (j: number) => boolean): { end: number; text: string } | null {
  const quote = quoteAt(src, k);
  if (quote) return quote.end - k <= MAX_NAME_WORDS && quote.text.length <= MAX_NAME_TEXT ? quote : null;
  const number = src.tokens[k];
  if (number?.kind === 'number') return { end: k + 1, text: number.number };
  const b = NAME_ARTICLES.has(wordAt(src, k) ?? '') ? k + 1 : k;
  if (!startsName(src.toks[b]) || quoted(src, b) || ends(b)) return null;
  let e = b + 1;
  while (e < src.tokens.length && src.toks[e] && !quoted(src, e) && !colonBefore(src, e) && !ends(e)) e += 1;
  while (e > b + 1 && WRITE_FILLERS.has(wordAt(src, e - 1) ?? '')) e -= 1;
  const text = writtenText(src, b, e);
  return e - b <= MAX_NAME_WORDS && text && text.length <= MAX_NAME_TEXT ? { end: e, text } : null;
}

/** A title or a text value written at k ("call Ravi", "AC not cooling"):
 * quoted text whole; else every word up to one that ends it (`ends`), a ":"
 * or a quote, as written; at most 200 characters. */
function titleAt(src: Source, k: number, ends: (j: number) => boolean): { end: number; text: string } | null {
  const quote = quoteAt(src, k);
  if (quote) return quote.text.length <= MAX_TEXT ? quote : null;
  const first = src.toks[k];
  if (!first || !/\p{L}/u.test(first.w) || quoted(src, k) || ends(k)) return null;
  let e = k + 1;
  while (e < src.tokens.length && src.toks[e] && !quoted(src, e) && !colonBefore(src, e) && !ends(e)) e += 1;
  while (e > k + 1 && WRITE_FILLERS.has(wordAt(src, e - 1) ?? '')) e -= 1;
  const text = writtenText(src, k, e);
  return text && text.length <= MAX_TEXT ? { end: e, text } : null;
}

/* ── Module words ─────────────────────────────────────────────────────────── */

interface ModulePhrase { key: string; words: readonly string[]; plural: boolean }

const modulePhraseCache = new WeakMap<object, readonly ModulePhrase[]>();

/** The registry's module words (GrammarContext.synonyms) as v1 words, longest
 * first, each marked plural where it names the module in the plural: its
 * plural label ("staff", "work orders"), or a singular synonym of the same
 * module plus s, es or ies ("tasks", "activities", "wos"). */
function modulePhrases(ctx: GrammarContext): readonly ModulePhrase[] {
  const hit = modulePhraseCache.get(ctx.synonyms);
  if (hit) return hit;
  const all = ctx.synonyms.map((s) => ({ key: s.key, words: phraseWordsV1(s.phrase) })).filter((s) => s.words.length > 0);
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
  const phrases = all.map((s): ModulePhrase => {
    const last = s.words[s.words.length - 1];
    const stems = [
      ...(last.endsWith('ies') ? [`${last.slice(0, -3)}y`] : []),
      ...(last.endsWith('es') ? [last.slice(0, -2)] : []),
      ...(last.endsWith('s') ? [last.slice(0, -1)] : []),
    ];
    const ofSingular = all.some((o) => o.key === s.key && o.words.length === s.words.length
      && o.words.every((w, i) => (i === s.words.length - 1 ? stems.includes(w) : w === s.words[i])));
    return { ...s, plural: ofSingular || same(s.words, phraseWordsV1(getModuleCap(s.key)?.labels.plural ?? '')) };
  }).sort((a, b) => b.words.length - a.words.length);
  modulePhraseCache.set(ctx.synonyms, phrases);
  return phrases;
}

/** The longest module word written at k. */
function moduleAt(src: Source, k: number, ctx: GrammarContext): ModulePhrase | null {
  return modulePhrases(ctx).find((p) => p.words.every((w, i) => wordAt(src, k + i) === w)) ?? null;
}

/* ── Fields ───────────────────────────────────────────────────────────────── */

type Option = { value: string; words: ReadonlyArray<readonly string[]> };

/** A field as the write grammar reads its words: from the WriteCap (a
 * request) or from the open form (a typed answer). */
interface Field {
  key: string; label: string; kind: WriteFieldKind;
  /** A year-less day already past is next year's (WriteFormField.future). */
  future: boolean;
  /** A typed answer: the open form holds a value. */
  filled: boolean;
  /** enum and stage: each value with the words naming it (its key, its label;
   * a stage also the outcome word that tags it alone: "won"). */
  options: readonly Option[];
  /** ref, ref_many and related: the modules it names; owner_user: 'user'. */
  refModules: readonly string[];
}

/** What a write of one module can fill: its fields, the field each role
 * names (WRITE_FIELD_SYNONYMS) and every field's words. */
interface Form {
  module: string;
  cap: WriteCap | undefined;
  fields: readonly Field[];
  role: Partial<Record<WriteFieldRole, Field>>;
  /** Labels, keys and WRITE_FIELD_SYNONYMS, longest first; words two fields share name neither. */
  labels: ReadonlyArray<{ words: readonly string[]; field: Field }>;
}

/** A stage field's values from the grammar's stage words (peekStages, read with the context). */
function stageOptions(info: GrammarModuleInfo): Option[] {
  const alone = (outcome: string | null): boolean => !!outcome && info.stages.filter((s) => s.outcome === outcome).length === 1;
  return info.stages.map((s) => ({
    value: s.key,
    words: [
      phraseWordsV1(s.key), phraseWordsV1(s.label),
      ...(alone(s.outcome) ? Object.keys(OUTCOME_WORDS).filter((w) => OUTCOME_WORDS[w] === s.outcome).map((w) => [w]) : []),
    ],
  }));
}

function capField(f: WriteFormField, info: GrammarModuleInfo | undefined): Field {
  const choice = f.kind === 'enum' || f.kind === 'stage';
  let options: Option[] = [];
  if (choice && info && info.stageField === f.key && info.stages.length) options = stageOptions(info);
  else if (choice) {
    const values = f.options?.from === 'static' ? f.options.values : info?.enums.find((e) => e.field === f.key)?.values ?? [];
    options = values.map((value) => ({ value, words: [phraseWordsV1(value)] }));
  }
  return {
    key: f.key, label: f.label, kind: f.kind, future: f.future === true, filled: false, options,
    refModules: f.kind === 'owner_user' ? ['user'] : f.related?.modules ?? (f.ref ? [f.ref.module] : []),
  };
}

function formField(f: FillField): Field {
  return {
    key: f.key, label: f.label, kind: f.kind, future: f.future === true, filled: f.filled,
    options: (f.options ?? []).map((o) => ({ value: o.value, words: [phraseWordsV1(o.value), phraseWordsV1(o.label)] })),
    refModules: f.refModules ?? [],
  };
}

function formOf(module: string, cap: WriteCap | undefined, fields: readonly Field[], info: GrammarModuleInfo | undefined): Form {
  const key = (k: string | undefined) => (k ? fields.find((f) => f.key === k) : undefined);
  const role: Form['role'] = {
    status: key(info?.stageField) ?? fields.find((f) => f.kind === 'stage'),
    date: fields.find((f) => f.kind === 'date' || f.kind === 'datetime'),
    priority: fields.find((f) => f.key === 'priority' && f.kind === 'enum'),
    title: key(cap?.primaryText),
    notes: key('notes') ?? key('description'),
  };
  const byWords = new Map<string, { words: readonly string[]; field: Field | null }>();
  const add = (words: readonly string[], field: Field): void => {
    if (!words.length) return;
    const id = words.join(' ');
    const seen = byWords.get(id);
    if (!seen) byWords.set(id, { words, field });
    else if (seen.field !== field) seen.field = null;
  };
  for (const f of fields) {
    add(phraseWordsV1(f.label), f);
    add(phraseWordsV1(f.key), f);
  }
  for (const s of WRITE_FIELD_SYNONYMS) {
    const f = role[s.role];
    if (f) add(s.words, f);
  }
  const labels = [...byWords.values()]
    .flatMap((e) => (e.field ? [{ words: e.words, field: e.field }] : []))
    .sort((a, b) => b.words.length - a.words.length);
  return { module, cap, fields, role, labels };
}

/** A WriteCap's fields for the op, as the grammar reads them. */
function capForm(module: string, cap: WriteCap, op: 'create' | 'update', info: GrammarModuleInfo | undefined): Form {
  return formOf(module, cap, cap.fields.filter((f) => f.ops.includes(op)).map((f) => capField(f, info)), info);
}

/** An operation the guided form takes, or answers with its notice (WriteCap.refused: an invoice's delete): read
 * alike, so the notice comes with no model call. */
const readsOp = (cap: WriteCap, op: WriteOp): boolean => cap.ops.includes(op) || !!cap.refused?.[op];

/** The field a name written at k is for ("priority", "due date", "assigned to"). */
function labelAt(form: Form, src: Source, k: number): { words: readonly string[]; field: Field } | null {
  return form.labels.find((l) => l.words.every((w, i) => wordAt(src, k + i) === w)) ?? null;
}

/** The longest value of `field` written at k ("in progress", "high", "won"). */
function optionAt(src: Source, k: number, field: Field): { value: string; len: number } | null {
  let best: { value: string; len: number } | null = null;
  for (const o of field.options) {
    for (const words of o.words) {
      if (words.length && (!best || words.length > best.len) && words.every((w, i) => wordAt(src, k + i) === w)) best = { value: o.value, len: words.length };
    }
  }
  return best;
}

const hasOption = (field: Field, value: string): boolean => field.options.some((o) => o.value === value);
const keyed = (form: Form, key: string | undefined): Field | undefined => (key ? form.fields.find((f) => f.key === key) : undefined);
/** A field that takes the caller ("assign to me"): a CRM owner, or Field Service staff. */
const isAssignable = (f: Field): boolean =>
  f.kind === 'owner_user' || ((f.kind === 'ref' || f.kind === 'ref_many') && f.refModules.includes('staff'));
/** The field naming records of `module` alone ("team Alpha": teamId; "customer ABC": customerId). */
const refFieldOf = (form: Form, module: string): Field | undefined =>
  form.fields.find((f) => (f.kind === 'ref' || f.kind === 'ref_many') && f.refModules.length === 1 && f.refModules[0] === module);
/** "with <name>": a call's related record (and contact name), a deal's contact. */
const withField = (form: Form): Field | undefined =>
  (form.module === 'call' ? keyed(form, form.cap?.forRef) : form.module === 'deal' ? refFieldOf(form, 'contact') : undefined);
/** "from <company>", "at <company>": a person's company, as text. */
const companyField = (form: Form): Field | undefined => (PEOPLE_MODULES.has(form.module) ? keyed(form, 'company') : undefined);

/* ── What is read ─────────────────────────────────────────────────────────── */

type When = { field: Field; value: DateTimeValue; note?: ClockNote };
/** What one part of a request or a typed answer reads: its tokens, and the
 * values, references or date-time it gives; a create's part may also give the
 * record it is made from, or its catalog lines (Increment 7). */
interface Got { len: number; values?: Record<string, WriteValue>; refs?: Refs; when?: When; from?: From; lines?: IntentLine[] }
interface Reading { values: Record<string, WriteValue>; refs: Refs; when: Map<string, When>; from?: From; lines?: IntentLine[] }
interface State { src: Source; ctx: GrammarContext; form: Form; opts: DateTimeOptions; taken: boolean[]; read: Reading }

function stateOf(src: Source, ctx: GrammarContext, form: Form, opts: DateTimeOptions): State {
  return { src, ctx, form, opts, taken: src.tokens.map(() => false), read: { values: {}, refs: {}, when: new Map() } };
}

const dateOptions = (ctx: GrammarContext): DateTimeOptions => ({
  todayKey: ctx.todayKey ?? '', ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
});
const whenOf = (field: Field, m: DateTimeMatch): When => (m.note ? { field, value: m.value, note: m.note } : { field, value: m.value });
const shift = (got: Got | null, n: number): Got | null => (got ? { ...got, len: got.len + n } : null);

/** A day and a time written apart for one field ("tomorrow for ABC at 3pm"). */
function joinDayAndTime(a: When, b: When): When | null {
  const day = a.value.kind === 'day' ? a.value : b.value.kind === 'day' ? b.value : null;
  const time = a.value.kind === 'time' ? a : b.value.kind === 'time' ? b : null;
  if (!day || !time || time.value.kind !== 'time') return null;
  return { field: a.field, value: { kind: 'day_time', date: day.date, time: time.value.time }, ...(time.note ? { note: time.note } : {}) };
}

/** Adds what a part read, unless it gives a field already given (the first
 * one written wins), except a day and a time written apart; likewise a second
 * record to make the create from, or a second list of lines. False: nothing
 * was added. */
function take(r: Reading, got: Got): boolean {
  const values = Object.keys(got.values ?? {});
  if (values.some((k) => hasOwn(r.values, k) || r.when.has(k)) || Object.keys(got.refs ?? {}).some((k) => hasOwn(r.refs, k))) return false;
  if ((got.from && r.from) || (got.lines && r.lines)) return false;
  if (got.when) {
    const key = got.when.field.key;
    const prev = r.when.get(key);
    const when = prev ? joinDayAndTime(prev, got.when) : got.when;
    if (!when || hasOwn(r.values, key)) return false;
    r.when.set(key, when);
  }
  Object.assign(r.values, got.values);
  Object.assign(r.refs, got.refs);
  if (got.from) r.from = got.from;
  if (got.lines) r.lines = got.lines;
  return true;
}

/** take, marking the part's tokens read. */
function takeAt(s: State, k: number, got: Got | null): boolean {
  if (!got || !take(s.read, got)) return false;
  for (let i = k; i < k + got.len; i += 1) s.taken[i] = true;
  return true;
}

/** The values and notes a reading writes: each date-time as its field takes
 * it (toWriteDate). An hour without am or pm, and midnight, are never
 * written: the day is kept and the field asks (L14). */
function finish(r: Reading): { values: Record<string, WriteValue>; refs: Refs; notes: Record<string, FieldNote> } {
  const values = { ...r.values };
  const notes: Record<string, FieldNote> = {};
  for (const [key, w] of r.when) {
    const kind = w.field.kind === 'datetime' ? 'datetime' : 'date';
    const out: { value?: WriteValue; note?: FieldNote } = kind === 'datetime' && w.value.kind === 'day_time' && w.note
      ? { value: { date: w.value.date }, note: w.note } : toWriteDate(w.value, kind);
    if (out.value !== undefined) values[key] = out.value;
    if (out.note) notes[key] = out.note;
  }
  return { values, refs: r.refs, notes };
}

/* ── Values by kind (an update's, a typed answer's) ───────────────────────── */

/** The tokens from k that end at `to` in the text (the last one exactly there). */
function covered(src: Source, k: number, to: number, text: string): { end: number; text: string } | null {
  let e = k;
  while (e < src.tokens.length && (src.spans[e]?.[1] ?? Infinity) <= to) e += 1;
  return e > k && src.spans[e - 1]?.[1] === to ? { end: e, text } : null;
}

/** An email or a phone written from token k on (EMAIL_AT_RE, PHONE_AT_RE). */
function rawAt(src: Source, k: number, sticky: RegExp): { end: number; text: string } | null {
  const span = src.spans[k];
  if (!span) return null;
  const phone = sticky === PHONE_AT_RE;
  const from = phone && src.text[span[0] - 1] === '+' ? span[0] - 1 : span[0];
  sticky.lastIndex = from;
  const m = sticky.exec(src.text);
  return m && !(phone && ISO_DAY_RE.test(m[0])) ? covered(src, k, from + m[0].length, m[0]) : null;
}

/** One name or "me" (a field that takes the caller) for `field`, or several
 * split on "and" and "," where it takes several (ref_many, at most
 * MAX_REFS). A list for a one-record field is not read. */
function refsAt(src: Source, k: number, field: Field, ends: (j: number) => boolean): { end: number; refs: RefInput | RefInput[] } | null {
  const many = field.kind === 'ref_many';
  const me = (j: number) => wordAt(src, j) === ME_WORD && isAssignable(field);
  // A name stops at "and" or a comma. Only "and" (or "me") continues a list: after a comma come
  // fillers and clauses as often as names ("assign to me, please"), so "Ravi, Kumar" takes Ravi
  // and leaves "Kumar" not taken, to be picked on the form.
  const stop = (j: number) => ends(j) || wordAt(src, j) === 'and' || gapBefore(src, j).includes(',');
  const list: RefInput[] = [];
  let j = k;
  for (;;) {
    if (me(j)) {
      list.push({ me: true });
      j += 1;
    } else {
      const name = nameAt(src, j, stop);
      if (!name) return null;
      list.push({ text: name.text });
      j = name.end;
    }
    const next = wordAt(src, j) === 'and' ? j + 1 : src.toks[j] && gapBefore(src, j).includes(',') ? j : -1;
    if (next < 0 || list.length >= MAX_REFS || !(me(next) || nameAt(src, next, stop))) break;
    j = next;
  }
  if (!many && list.length > 1) return null;
  return { end: j, refs: many ? list : list[0] };
}

/** A text for `field`; a lead's or a contact's name goes to its two fields
 * ("Ravi Kumar": first and last, WriteCap.nameSplit). */
function textGot(form: Form, field: Field | undefined, text: string, len: number): Got | null {
  if (!field) return null;
  const split = form.cap?.nameSplit;
  if (split && field.key === split.first) {
    const [first, ...rest] = text.split(' ');
    return { len, values: { [split.first]: first, ...(rest.length && keyed(form, split.last) ? { [split.last]: rest.join(' ') } : {}) } };
  }
  return { len, values: { [field.key]: text } };
}

/** An amount at k ("5 lakh", "$5,000") and its currency where the form has a
 * currency field that takes it (a deal's). */
function moneyOf(form: Form, field: Field, src: Source, k: number): Got | null {
  const m = matchMoney(src.toks, k);
  if (!m) return null;
  const currency = keyed(form, 'currency');
  const values: Record<string, WriteValue> = { [field.key]: m.value };
  if (m.currency && currency && hasOption(currency, m.currency)) values[currency.key] = m.currency;
  return { len: m.length, values };
}

/** A value for `field` written at k, read by its kind ("high", "tomorrow
 * 3pm", "Ravi and Kumar", "me", "5 lakh", an email). A text runs until
 * `ends`; a name also ends at a write word or a date-time. */
function valueAt(s: State, k: number, field: Field, ends: (j: number) => boolean): Got | null {
  const { src, form } = s;
  const key = field.key;
  switch (field.kind) {
    case 'enum':
    case 'stage': {
      const o = optionAt(src, k, field);
      return o ? { len: o.len, values: { [key]: o.value } } : null;
    }
    case 'boolean': {
      const w = wordAt(src, k);
      return w !== undefined && hasOwn(YES_NO_WORDS, w) ? { len: 1, values: { [key]: YES_NO_WORDS[w] } } : null;
    }
    case 'number':
    case 'percent': {
      const t = src.toks[k];
      return t && t.num !== undefined && !t.neg && !src.toks[k + 1]?.glued ? { len: 1, values: { [key]: t.num } } : null;
    }
    case 'money':
      return moneyOf(form, field, src, k);
    case 'date':
    case 'datetime': {
      const m = matchDateTimeAt(src, k, { ...s.opts, future: field.future });
      return m ? { len: m.length, when: whenOf(field, m) } : null;
    }
    case 'email':
    case 'phone': {
      const raw = rawAt(src, k, field.kind === 'email' ? EMAIL_AT_RE : PHONE_AT_RE);
      return raw ? { len: raw.end - k, values: { [key]: raw.text } } : null;
    }
    case 'ref':
    case 'ref_many':
    case 'owner_user':
    case 'related': {
      const nameEnds = (j: number) => ends(j) || WRITE_NAME_END.has(wordAt(src, j) ?? '') || !!matchDateTimeAt(src, j, s.opts);
      const refs = refsAt(src, k, field, nameEnds);
      return refs ? { len: refs.end - k, refs: { [key]: refs.refs } } : null;
    }
    case 'multiselect':
      return null;
    default: {
      const text = titleAt(src, k, ends);
      return text ? textGot(form, field, text.text, text.end - k) : null;
    }
  }
}

/** Where an update's or a typed answer's value ends: at another field's
 * name, written alone, after "set", or after "and" ("notes to call back and
 * set priority to high"). */
function textEnds(src: Source, form: Form): (j: number) => boolean {
  const field = (j: number): boolean => !!labelAt(form, src, j) || (wordAt(src, j) === 'set' && !!labelAt(form, src, j + 1));
  return (j) => field(j) || (wordAt(src, j) === 'and' && field(j + 1));
}

/* ── Creates ──────────────────────────────────────────────────────────────── */

interface Create extends State {
  /** The first token after the module's name. */
  start: number;
  /** The module the create may be made from (WorkflowModule.source, with a WriteCap.forRef: an invoice's work order). */
  fromModule?: string;
}

/** A date-time for the module's date field (spec B7: a work order's scheduled
 * date, a call's date, a task's due date, an activity's, a deal's close date). */
function dateGot(s: State, k: number): Got | null {
  const field = s.form.role.date;
  const m = field ? matchDateTimeAt(s.src, k, { ...s.opts, future: field.future }) : null;
  return field && m ? { len: m.length, when: whenOf(field, m) } : null;
}

/** "priority high", "high priority", "urgent" (high), "critical" (where it is a value: tickets). */
function priorityGot(s: State, k: number): Got | null {
  const field = s.form.role.priority;
  const w = wordAt(s.src, k);
  if (!field || w === undefined) return null;
  const got = (value: string, len: number): Got => ({ len, values: { [field.key]: value } });
  if (w === 'priority') {
    const j = VALUE_JOINERS.has(wordAt(s.src, k + 1) ?? '') ? k + 2 : k + 1;
    const o = optionAt(s.src, j, field);
    return o ? got(o.value, j + o.len - k) : null;
  }
  const o = optionAt(s.src, k, field);
  if (o && wordAt(s.src, k + o.len) === 'priority') return got(o.value, o.len + 1);
  return hasOwn(PRIORITY_WORDS, w) && hasOption(field, PRIORITY_WORDS[w]) ? got(PRIORITY_WORDS[w], 1) : null;
}

/** "status open", "as qualified", "in proposal stage": the stage or status field's value. */
function statusGot(s: State, k: number): Got | null {
  const field = s.form.role.status;
  const w = wordAt(s.src, k);
  if (!field || (w !== 'status' && w !== 'as' && w !== 'in')) return null;
  const j = w === 'status' && VALUE_JOINERS.has(wordAt(s.src, k + 1) ?? '') ? k + 2 : k + 1;
  const o = optionAt(s.src, j, field);
  if (!o) return null;
  const values = { [field.key]: o.value };
  if (w !== 'in') return { len: j + o.len - k, values };
  // "in <stage> stage" (or "status") only: "in proposal" alone may say where, not which stage.
  const tail = STAGE_TAILS.find((t) => t.every((x, i) => wordAt(s.src, j + o.len + i) === x));
  return tail ? { len: j + o.len + tail.length - k, values } : null;
}

/** A call's direction ("incoming", "outbound") and status ("missed", "completed", "planned"). */
function callGot(s: State, k: number): Got | null {
  const w = wordAt(s.src, k);
  if (s.form.module !== 'call' || w === undefined) return null;
  const direction = hasOwn(CALL_DIRECTION_WORDS, w);
  const field = direction ? keyed(s.form, 'direction') : CALL_STATUS_WORDS.has(w) ? s.form.role.status : undefined;
  const value = direction ? CALL_DIRECTION_WORDS[w] : w;
  return field && hasOption(field, value) ? { len: 1, values: { [field.key]: value } } : null;
}

/** "worth 5 lakh", "for $5,000": a deal's amount. */
function moneyGot(s: State, k: number): Got | null {
  const field = keyed(s.form, 'amount');
  return field?.kind === 'money' ? moneyOf(s.form, field, s.src, k) : null;
}

/** Whether another part of a create starts at k: where a name or a title
 * ends. Read from the words alone (the name after "for" is not). In a title
 * "to" starts nothing ("to send the report to Ravi"). */
function partStarts(c: Create, k: number, inTitle: boolean): boolean {
  const { src, form } = c;
  const w = wordAt(src, k);
  if (w === undefined || c.taken[k] || quoted(src, k) || colonBefore(src, k)) return true;
  if (TITLE_WORDS.has(w) || w === 'for') return true;
  if (w === 'to') return !inTitle && TO_TITLE_MODULES.has(form.module);
  if (w === 'with') return !!withField(form) || !!form.cap?.lines;
  if (ASSIGN_WORDS.has(w)) return form.fields.some(isAssignable);
  if (w === 'team') return !!refFieldOf(form, 'team');
  if (w === 'from') return !!companyField(form) || !!fromGot(c, k);
  if (w === 'at' && (companyField(form) || refFieldOf(form, 'site'))) return true;
  if (w === 'due') return !!form.role.date;
  if (w === 'worth') return !!moneyGot(c, k + 1);
  return !!(dateGot(c, k) || priorityGot(c, k) || statusGot(c, k) || callGot(c, k));
}

/** A name also ends at a date-time where the module has no date field ("for
 * Kumar Traders tomorrow" on a ticket: the day is not taken, L3), as an
 * update's or a typed answer's name does. */
const nameEnds = (c: Create) => (j: number): boolean =>
  WRITE_NAME_END.has(wordAt(c.src, j) ?? '') || partStarts(c, j, false) || !!matchDateTimeAt(c.src, j, c.opts);
const titleEnds = (c: Create) => (j: number): boolean => partStarts(c, j, true);

/** The title or name written at k: a person's, a company's, a category's, a site's or a team's is a name
 * (NAMED_MODULES), the others' a title. */
function primaryGot(c: Create, k: number): Got | null {
  const t = NAMED_MODULES.has(c.form.module) ? nameAt(c.src, k, nameEnds(c)) : titleAt(c.src, k, titleEnds(c));
  return t ? textGot(c.form, c.form.role.title, t.text, t.end - k) : null;
}

/** A name for `field` after the word at k ("for ABC Industries", "with
 * Kumar"); the referenced module's own word may come first ("for customer
 * ABC"). alsoContactName: the name is the contact name too (L22). */
function nameRefGot(c: Create, k: number, field: Field, alsoContactName: boolean): Got | null {
  let j = k + 1;
  const named = moduleAt(c.src, j, c.ctx);
  if (named && !named.plural && field.refModules.includes(named.key)) j += named.words.length;
  const name = nameAt(c.src, j, nameEnds(c));
  if (!name) return null;
  const contactName = alsoContactName ? keyed(c.form, 'contactName') : undefined;
  return {
    len: name.end - k,
    refs: { [field.key]: field.kind === 'ref_many' ? [{ text: name.text }] : { text: name.text } },
    ...(contactName ? { values: { [contactName.key]: name.text } } : {}),
  };
}

/** "team Alpha", "at Chennai warehouse" (a site), "from Infosys" (a
 * person's company, as text): a name after the word at k. */
function namedGot(c: Create, k: number, field: Field | undefined): Got | null {
  const name = field ? nameAt(c.src, k + 1, nameEnds(c)) : null;
  if (!field || !name) return null;
  if (field.kind === 'text') return { len: name.end - k, values: { [field.key]: name.text } };
  return { len: name.end - k, refs: { [field.key]: field.kind === 'ref_many' ? [{ text: name.text }] : { text: name.text } } };
}

/** "for team Alpha" (a work order), "for tomorrow", "for 5 lakh" (a deal), "for ABC Industries" (WriteCap.forRef). */
function forGot(c: Create, k: number): Got | null {
  const team = wordAt(c.src, k + 1) === 'team' ? refFieldOf(c.form, 'team') : undefined;
  if (team) return shift(namedGot(c, k + 1, team), 1);
  const other = dateGot(c, k + 1) ?? moneyGot(c, k + 1);
  if (other) return shift(other, 1);
  const field = keyed(c.form, c.form.cap?.forRef);
  return field ? nameRefGot(c, k, field, FOR_CONTACT_NAME_MODULES.has(c.form.module)) : null;
}

/** "assign to Ravi", "assigned to Ravi and Kumar", "assign to me". */
function assignGot(c: Create, k: number): Got | null {
  const field = c.form.fields.find(isAssignable);
  if (!field || wordAt(c.src, k + 1) !== 'to') return null;
  const refs = refsAt(c.src, k + 2, field, nameEnds(c));
  return refs ? { len: refs.end - k, refs: { [field.key]: refs.refs } } : null;
}

/** A record number of the module the create is made from, at k ("9A218C-WO-0042": its code is that module's). */
function sourceNumberGot(c: Create, k: number): Got | null {
  const t = c.src.tokens[k];
  return c.fromModule && t?.kind === 'number' && BUSINESS_NUMBER_MODULES[t.code] === c.fromModule
    ? { len: 1, from: { module: c.fromModule, number: t.number } } : null;
}

/** The record the create is made from, after "for" or "from" at k (spec
 * B10.2): its number, perhaps after "the" and the module's own words ("for
 * 9A218C-WO-0042", "from work order 9A218C-WO-0042"), or "this" or "that"
 * and the module's words (the record on screen). Anything else is not one:
 * "for ABC Industries" stays the customer (forRef). */
function fromGot(c: Create, k: number): Got | null {
  const w = wordAt(c.src, k);
  if (!c.fromModule || (w !== 'for' && w !== 'from')) return null;
  const moduleWordsAt = (j: number): number => {
    const named = moduleAt(c.src, j, c.ctx);
    return named && !named.plural && named.key === c.fromModule ? named.words.length : 0;
  };
  if (FOCUS_WORDS.has(wordAt(c.src, k + 1) ?? '')) {
    const n = moduleWordsAt(k + 2);
    return n ? { len: 2 + n, from: { focus: true } } : null;
  }
  let j = wordAt(c.src, k + 1) === 'the' ? k + 2 : k + 1;
  j += moduleWordsAt(j);
  return shift(sourceNumberGot(c, j), j - k);
}

/** Where the words of a line starting at `from` end: "and", a comma after its first word, or where a name ends
 * ("for", "to", a date-time, another part). */
function lineEnds(c: Create, from: number): (j: number) => boolean {
  const ends = nameEnds(c);
  return (j) => wordAt(c.src, j) === 'and' || (j > from && gapBefore(c.src, j).includes(',')) || ends(j);
}

/** One catalog line at k: an optional quantity (a numeral, or a word from one
 * to twenty), then the item's words, read as a name is (nameAt: at most
 * MAX_NAME_WORDS words and 100 characters). A quantity the intent can't hold
 * (0, a negative, "5k", past 100,000) reads no line. */
function lineAt(c: Create, k: number): { end: number; line: IntentLine } | null {
  const t = c.src.toks[k];
  const numeral = t?.num !== undefined && !t.neg && !c.src.toks[k + 1]?.glued ? t.num : undefined;
  const qty = numeral ?? (t && t.num === undefined && hasOwn(LINE_QTY_WORDS, t.w) ? LINE_QTY_WORDS[t.w] : undefined);
  if (qty !== undefined && !(qty > 0 && qty <= MAX_LINE_QTY)) return null;
  const at = qty === undefined ? k : k + 1;
  const name = nameAt(c.src, at, lineEnds(c, at));
  return name ? { end: name.end, line: { catalog: 'service', text: name.text, ...(qty === undefined ? {} : { qty }) } } : null;
}

/** "with 2 AC service and 1 filter", "with two AC service, one filter": a
 * document's catalog lines (WriteCap.lines, spec B10.2), named in words and
 * priced on the server from the service catalog. "and" or a comma goes on to
 * the next line, at most MAX_INTENT_LINES. */
function linesGot(c: Create, k: number): Got | null {
  const lines: IntentLine[] = [];
  let end = k;
  for (let j = k + 1; lines.length < MAX_INTENT_LINES;) {
    const item = lineAt(c, j);
    if (!item) break;
    lines.push(item.line);
    end = item.end;
    j = wordAt(c.src, end) === 'and' ? end + 1 : c.src.toks[end] && gapBefore(c.src, end).includes(',') ? end : -1;
    if (j < 0) break;
  }
  return lines.length ? { len: end - k, lines } : null;
}

/** One part of a create at k (spec B7), or null: its words stay unread. */
function createPartAt(c: Create, k: number): Got | null {
  const { src, form } = c;
  const quote = quoteAt(src, k);
  if (quote) return textGot(form, form.role.title, quote.text, quote.end - k);
  if (k >= c.start && colonBefore(src, k)) {
    // ": AC not cooling": the title, to the end.
    let e = k;
    while (e < src.tokens.length && !c.taken[e]) e += 1;
    const text = writtenText(src, k, e);
    return text && text.length <= MAX_TEXT ? textGot(form, form.role.title, text, e - k) : null;
  }
  const w = wordAt(src, k);
  if (w === undefined) return null;
  if (TITLE_WORDS.has(w)) return shift(primaryGot(c, k + 1), 1);
  if (w === 'to' && TO_TITLE_MODULES.has(form.module)) {
    const t = titleAt(src, k + 1, titleEnds(c));
    return t ? textGot(form, form.role.title, t.text, t.end - k) : null;
  }
  if (w === 'for') return fromGot(c, k) ?? forGot(c, k);
  if (w === 'with') return form.cap?.lines ? linesGot(c, k) : withGot(c, k);
  if (ASSIGN_WORDS.has(w)) return assignGot(c, k);
  if (w === 'team') return namedGot(c, k, refFieldOf(form, 'team'));
  if (w === 'from') return fromGot(c, k) ?? namedGot(c, k, companyField(form));
  if (w === 'at') return dateGot(c, k) ?? namedGot(c, k, refFieldOf(form, 'site') ?? companyField(form));
  if (w === 'due') return shift(dateGot(c, k + 1), 1);
  if (w === 'worth') return shift(moneyGot(c, k + 1), 1);
  return dateGot(c, k) ?? priorityGot(c, k) ?? statusGot(c, k) ?? callGot(c, k);
}

function withGot(c: Create, k: number): Got | null {
  const field = withField(c.form);
  return field ? nameRefGot(c, k, field, c.form.module === 'call') : null;
}

/** A person's email and phone, written anywhere after the module (spec B7). */
function readContacts(c: Create): void {
  if (!PEOPLE_MODULES.has(c.form.module)) return;
  const kinds = [[EMAIL_RE, keyed(c.form, 'email')], [PHONE_RE, keyed(c.form, 'phone')]] as const;
  for (const [re, field] of kinds) {
    if (!field) continue;
    for (const m of c.src.text.matchAll(re)) {
      // An email written in brackets: from its first letter or digit.
      const lead = /^[^\p{L}\p{N}+]*/u.exec(m[0])?.[0].length ?? 0;
      const text = m[0].slice(lead);
      const at = (m.index ?? 0) + lead + (text.startsWith('+') ? 1 : 0);
      const k = c.src.spans.findIndex((span) => span?.[0] === at);
      const run = k >= c.start && !(re === PHONE_RE && ISO_DAY_RE.test(text)) ? covered(c.src, k, (m.index ?? 0) + m[0].length, text) : null;
      if (run && !c.taken.slice(k, run.end).some(Boolean)) takeAt(c, k, { len: run.end - k, values: { [field.key]: text } });
    }
  }
}

function readCreate(c: Create): void {
  readContacts(c);
  // "create an invoice 9A218C-WO-0042": the record it is made from, by its number right after the module.
  takeAt(c, c.start, sourceNumberGot(c, c.start));
  // The words right after the module: the title ("create a task call Ravi") or the name ("add a customer ABC Industries").
  if (BARE_TITLE_MODULES.has(c.form.module) && startsName(c.src.toks[c.start]) && !partStarts(c, c.start, false)) {
    takeAt(c, c.start, primaryGot(c, c.start));
  }
  for (let k = c.start; k < c.src.tokens.length;) {
    const got = c.taken[k] ? null : createPartAt(c, k);
    k += got && takeAt(c, k, got) ? got.len : 1;
  }
}

/** "new" with a date anywhere asks for records ("new task tomorrow", L4): a read's date phrase, or a day. */
function namesADate(src: Source, opts: DateTimeOptions): boolean {
  for (let k = 0; k < src.tokens.length; k += 1) {
    if (matchDateExpr(src.toks, k, { todayKey: opts.todayKey })) return true;
    const m = matchDateTimeAt(src, k, opts);
    if (m && m.value.kind !== 'time') return true;
  }
  return false;
}

function parseCreate(src: Source, at: number, verb: string, ctx: GrammarContext, opts: DateTimeOptions): WriteParse {
  let k = at + 1;
  if (CREATE_ARTICLES.has(wordAt(src, k) ?? '')) k += 1;
  if (verb !== NEW_WORD && wordAt(src, k) === NEW_WORD) k += 1;
  const phrase = moduleAt(src, k, ctx);
  if (verb === NEW_WORD && (phrase?.plural || namesADate(src, opts))) return READ_LIKE;
  if (!phrase || phrase.plural) return UNCERTAIN;
  const wf = WORKFLOW_MODULE_KEYS.has(phrase.key) ? workflowModuleFor(phrase.key) : undefined;
  if (!wf || !readsOp(wf.cap, 'create')) return NOT_WORKFLOW;
  const form = capForm(phrase.key, wf.cap, 'create', ctx.moduleInfo?.(phrase.key));
  const fromModule = wf.cap.forRef ? wf.source?.module : undefined;
  const c: Create = { ...stateOf(src, ctx, form, opts), start: k + phrase.words.length, ...(fromModule ? { fromModule } : {}) };
  readCreate(c);
  return intentOf({ v: 1, op: 'create', module: phrase.key }, c.read, notTakenOf(src, c.taken, c.start));
}

/* ── Updates and deletes ──────────────────────────────────────────────────── */

interface Target { module: string; target: NonNullable<WriteIntent['target']>; end: number; form: Form }

/** The record an update or a delete names at k (spec B7): a record number
 * (its module from its code), "this" or "that" and a module (the record on
 * screen), a module and the record's name up to where the change starts, or
 * a module alone (the record on screen). A plural, or anything else, is
 * uncertain. */
function targetAt(src: Source, k: number, op: 'update' | 'delete', ctx: GrammarContext): Target | WriteParse {
  const at = wordAt(src, k) === 'the' ? k + 1 : k;
  const number = src.tokens[at];
  let module: string | undefined;
  let target: Target['target'] | undefined;
  let end = at + 1;
  if (number?.kind === 'number') {
    module = BUSINESS_NUMBER_MODULES[number.code];
    target = { number: number.number };
  } else {
    const focus = FOCUS_WORDS.has(wordAt(src, at) ?? '');
    const phrase = moduleAt(src, focus ? at + 1 : at, ctx);
    if (!phrase || phrase.plural) return UNCERTAIN;
    module = phrase.key;
    end = (focus ? at + 1 : at) + phrase.words.length;
    const next = src.tokens[end];
    if (focus) target = { focus: true };
    else if (next?.kind === 'number') {
      // "work order <number>": the number's own module.
      if (BUSINESS_NUMBER_MODULES[next.code] !== module) return UNCERTAIN;
      target = { number: next.number };
      end += 1;
    }
  }
  if (!module) return UNCERTAIN;
  const cap = WORKFLOW_MODULE_KEYS.has(module) ? writeCapFor(module) : undefined;
  if (!cap || !readsOp(cap, op)) return NOT_WORKFLOW;
  const form = capForm(module, cap, 'update', ctx.moduleInfo?.(module));
  if (!target) {
    const ends = (j: number): boolean => WRITE_NAME_END.has(wordAt(src, j) ?? '') || WRITE_TARGET_END.has(wordAt(src, j) ?? '') || !!labelAt(form, src, j);
    const name = nameAt(src, end, ends);
    if (name) {
      target = { text: name.text };
      end = name.end;
    } else if (end < src.tokens.length && !ends(end) && !WRITE_FILLERS.has(wordAt(src, end) ?? '')) return UNCERTAIN;
    else target = { focus: true };
  }
  return { module, target, end, form };
}

/** What the verb itself asks right after the record: "mark <record> [as]
 * done", "move <record> to won", "assign <record> to Ravi". */
function verbPartAt(s: State, verb: string, k: number): Got | null {
  const { src, form } = s;
  const status = form.role.status;
  if ((verb === 'mark' || verb === 'move') && status) {
    const lead = verb === 'mark' ? (wordAt(src, k) === 'as' ? 1 : 0) : wordAt(src, k) === 'to' ? 1 : -1;
    const o = lead < 0 ? null : optionAt(src, k + lead, status);
    return o ? { len: lead + o.len, values: { [status.key]: o.value } } : null;
  }
  const field = verb === 'assign' ? form.fields.find(isAssignable) : undefined;
  return field && wordAt(src, k) === 'to' ? shift(valueAt(s, k + 1, field, textEnds(src, form)), 1) : null;
}

/** "<field> [to|is|as|=|:] <value>", perhaps after "set" ("update lead Ravi set email to ..."). */
function updatePartAt(s: State, k: number): Got | null {
  const at = wordAt(s.src, k) === 'set' ? k + 1 : k;
  const label = labelAt(s.form, s.src, at);
  if (!label) return null;
  const j = VALUE_JOINERS.has(wordAt(s.src, at + label.words.length) ?? '') ? at + label.words.length + 1 : at + label.words.length;
  const got = valueAt(s, j, label.field, textEnds(s.src, s.form));
  return got ? { ...got, len: j + got.len - k } : null;
}

/** The changes written after the record, from k on. */
function readChange(s: State, t: Target, k: number, verb: string): WriteParse {
  const first = verbPartAt(s, verb, k);
  for (let j = first && takeAt(s, k, first) ? k + first.len : k; j < s.src.tokens.length;) {
    const got = s.taken[j] ? null : updatePartAt(s, j);
    j += got && takeAt(s, j, got) ? got.len : 1;
  }
  return intentOf({ v: 1, op: 'update', module: t.module, target: t.target }, s.read, notTakenOf(s.src, s.taken, t.end));
}

/** "change the priority of ticket <number> to high", "set the status of this
 * task to done": the field before "of", the record after it, then the value. */
function fieldOfChange(src: Source, k: number, ctx: GrammarContext, opts: DateTimeOptions): WriteParse | null {
  const b = wordAt(src, k) === 'the' ? k + 1 : k;
  let of = b + 1;
  while (of < src.tokens.length && of <= b + 4 && wordAt(src, of) !== 'of') of += 1;
  if (wordAt(src, of) !== 'of') return null;
  const t = targetAt(src, of + 1, 'update', ctx);
  if ('kind' in t) return t;
  const label = labelAt(t.form, src, b);
  if (!label || b + label.words.length !== of) return UNCERTAIN;
  const s = stateOf(src, ctx, t.form, opts);
  const j = VALUE_JOINERS.has(wordAt(src, t.end) ?? '') ? t.end + 1 : t.end;
  const value = valueAt(s, j, label.field, textEnds(src, t.form));
  takeAt(s, t.end, value ? { ...value, len: j + value.len - t.end } : null);
  return readChange(s, t, t.end, '');
}

function parseChange(src: Source, at: number, op: 'update' | 'delete', verb: string, ctx: GrammarContext, opts: DateTimeOptions): WriteParse {
  if (op === 'update' && FIELD_OF_VERBS.has(verb)) {
    const fieldOf = fieldOfChange(src, at + 1, ctx, opts);
    if (fieldOf && fieldOf.kind !== 'uncertain') return fieldOf;
  }
  const t = targetAt(src, at + 1, op, ctx);
  if ('kind' in t) return t;
  const s = stateOf(src, ctx, t.form, opts);
  if (op === 'update') return readChange(s, t, t.end, verb);
  // A delete names its record and nothing else: another word makes the record uncertain.
  for (let k = t.end; k < src.tokens.length; k += 1) if (!WRITE_FILLERS.has(wordAt(src, k) ?? '')) return UNCERTAIN;
  return intentOf({ v: 1, op, module: t.module, target: t.target }, s.read, []);
}

/* ── The intent ───────────────────────────────────────────────────────────── */

/** The words no part read, as written: one entry per run of them (fillers
 * alone are none), at most FORM_CAPS.notTaken of at most 120 characters. */
function notTakenOf(src: Source, taken: readonly boolean[], from: number): string[] {
  const out: string[] = [];
  const filler = (j: number) => WRITE_FILLERS.has(wordAt(src, j) ?? '');
  for (let k = from; k < src.tokens.length && out.length < FORM_CAPS.notTaken;) {
    if (taken[k]) {
      k += 1;
      continue;
    }
    let e = k;
    while (e < src.tokens.length && !taken[e]) e += 1;
    let a = k;
    let b = e;
    while (a < b && filler(a)) a += 1;
    while (b > a && filler(b - 1)) b -= 1;
    const text = a < b ? writtenText(src, a, b) : '';
    if (text) out.push(text.length > MAX_NOT_TAKEN_TEXT ? text.slice(0, MAX_NOT_TAKEN_TEXT).trimEnd() : text);
    k = e;
  }
  return out;
}

/** The intent, its notes and the words not taken. What the contract refuses
 * (a value too long) leaves the request uncertain: fail closed. */
function intentOf(base: WriteIntent, r: Reading, notTaken: string[]): WriteParse {
  const out = finish(r);
  const intent: WriteIntent = {
    ...base,
    ...(r.from ? { from: r.from } : {}),
    ...(Object.keys(out.refs).length ? { refs: out.refs } : {}),
    ...(Object.keys(out.values).length ? { values: out.values } : {}),
    ...(r.lines?.length ? { lines: r.lines } : {}),
  };
  return WriteIntentSchema.safeParse(intent).success ? { kind: 'intent', intent, notTaken, fieldNotes: out.notes } : UNCERTAIN;
}

/** The write a v0 legacy parse names, or why it can't be read with certainty
 * (read_like, uncertain, not_workflow). Only a 'write' parse with the
 * tenant's today in the context is read, and only within the caps
 * (MAX_MESSAGE_CHARS, MAX_REQUEST_TOKENS). */
export function parseWriteIntent(message: string, v0: Extract<GrammarParse, { kind: 'legacy' }>, ctx: GrammarContext): WriteParse {
  if (v0.reason !== 'write' || !isDayKey(ctx.todayKey)) return UNCERTAIN;
  const src = sourceOf(message, MAX_REQUEST_TOKENS);
  if (!src) return UNCERTAIN;
  let at = 0;
  while (at < src.tokens.length && POLITE_PREFIX.has(wordAt(src, at) ?? '')) at += 1;
  const verb = wordAt(src, at);
  const opts = dateOptions(ctx);
  if (verb !== undefined && CREATE_VERBS.has(verb)) return parseCreate(src, at, verb, ctx, opts);
  if (verb !== undefined && UPDATE_VERBS.has(verb)) return parseChange(src, at, 'update', verb, ctx, opts);
  if (verb !== undefined && DELETE_VERBS.has(verb)) return parseChange(src, at, 'delete', verb, ctx, opts);
  return UNCERTAIN;
}

/* ── Typed answers to an open form ────────────────────────────────────────── */

/** The whole message as words, polite words before it and fillers after it
 * aside ("ok, cancel it please"); null with a record number in it. */
function wholeMessage(src: Source): string | null {
  if (src.toks.some((t) => !t)) return null;
  const words = src.toks.map((t) => t?.w ?? '');
  let a = 0;
  let b = words.length;
  while (a < b && POLITE_PREFIX.has(words[a])) a += 1;
  while (b > a && WRITE_FILLERS.has(words[b - 1])) b -= 1;
  return words.slice(a, b).join(' ');
}

/** A date-time for the form's date field: its only one, or (several) its first empty one. */
function fillDateAt(s: State, k: number): Got | null {
  const dates = s.form.fields.filter((f) => f.kind === 'date' || f.kind === 'datetime');
  const field = dates.length === 1 ? dates[0] : dates.find((f) => !f.filled);
  const m = field ? matchDateTimeAt(s.src, k, { ...s.opts, future: field.future }) : null;
  return field && m ? { len: m.length, when: whenOf(field, m) } : null;
}

/** One part of a typed answer at k (spec B7): "<field> [is|to|=|:] <value>",
 * "customer|site|team|staff <name>", "assign to <names>", "for <name>",
 * "me", a date-time, the value of exactly one select or stage field, or yes
 * or no for the one yes/no field. */
function fillPartAt(s: State, k: number): Got | null {
  const { src, form } = s;
  const nameEnd = (j: number): boolean =>
    WRITE_NAME_END.has(wordAt(src, j) ?? '') || !!labelAt(form, src, j) || !!matchDateTimeAt(src, j, s.opts);
  const refsGot = (field: Field | undefined, j: number): Got | null => {
    const named = field ? moduleAt(src, j, s.ctx) : null;
    const from = named && field?.refModules.includes(named.key) ? j + named.words.length : j;
    const refs = field ? refsAt(src, from, field, nameEnd) : null;
    return field && refs ? { len: refs.end - k, refs: { [field.key]: refs.refs } } : null;
  };
  const label = labelAt(form, src, k);
  if (label) {
    const after = k + label.words.length;
    const j = VALUE_JOINERS.has(wordAt(src, after) ?? '') ? after + 1 : after;
    const got = valueAt(s, j, label.field, textEnds(src, form));
    if (got) return { ...got, len: j + got.len - k };
  }
  const w = wordAt(src, k);
  if (w === undefined) return null;
  const named = moduleAt(src, k, s.ctx);
  const byModule = named && !named.plural ? refFieldOf(form, named.key) : undefined;
  if (named && byModule) return refsGot(byModule, k + named.words.length);
  if (ASSIGN_WORDS.has(w)) return refsGot(single(form.fields.filter(isAssignable)), wordAt(src, k + 1) === 'to' ? k + 2 : k + 1);
  if (w === 'for') return shift(fillDateAt(s, k + 1), 1) ?? refsGot(keyed(form, form.cap?.forRef), k + 1);
  if (w === ME_WORD) {
    const field = single(form.fields.filter(isAssignable));
    return field ? { len: 1, refs: { [field.key]: field.kind === 'ref_many' ? [{ me: true }] : { me: true } } } : null;
  }
  const date = fillDateAt(s, k);
  if (date) return date;
  // A value of exactly one select or stage field ("high", "in progress"); a value two fields have names neither.
  let best: { field: Field; value: string; len: number } | null = null;
  let shared = false;
  for (const field of form.fields) {
    const o = field.kind === 'enum' || field.kind === 'stage' ? optionAt(src, k, field) : null;
    if (!o || (best && o.len < best.len)) continue;
    shared = !!best && o.len === best.len;
    if (!shared) best = { field, value: o.value, len: o.len };
  }
  if (best && !shared) return { len: best.len, values: { [best.field.key]: best.value } };
  const yesNo = hasOwn(YES_NO_WORDS, w) ? single(form.fields.filter((f) => f.kind === 'boolean')) : undefined;
  return yesNo ? { len: 1, values: { [yesNo.key]: YES_NO_WORDS[w] } } : null;
}

/** A typed answer to the open form (at most MAX_GRAMMAR_WORDS tokens and
 * MAX_MESSAGE_CHARS characters), claimed only when every word is used; else
 * null and the message is read normally. */
export function parseFill(message: string, spec: FillFormSpec, ctx: GrammarContext): FillParse | null {
  const src = sourceOf(message, MAX_GRAMMAR_WORDS);
  const n = src?.tokens.length ?? 0;
  if (!src || n === 0) return null;
  const said = wholeMessage(src);
  if (said !== null && FILL_CANCEL_PHRASES.has(said)) return { kind: 'cancel' };
  if (said !== null && FILL_REVIEW_PHRASES.has(said)) return { kind: 'review' };
  if (!isDayKey(ctx.todayKey)) return null;
  const form = formOf(spec.module, writeCapFor(spec.module), spec.fields.map(formField), ctx.moduleInfo?.(spec.module));
  const s = stateOf(src, ctx, form, dateOptions(ctx));
  // A leading update verb asks nothing more ("set the priority to high"); "assign" starts "assign to me".
  const first = wordAt(src, 0);
  let k = first !== undefined && UPDATE_VERBS.has(first) && !ASSIGN_WORDS.has(first) ? 1 : 0;
  let read = false;
  while (k < n) {
    const w = wordAt(src, k);
    if (w !== undefined && (WRITE_FILLERS.has(w) || NAME_ARTICLES.has(w))) {
      k += 1;
      continue;
    }
    const got = fillPartAt(s, k);
    if (!got || !take(s.read, got)) return null;
    read = true;
    k += got.len;
  }
  if (!read) return null;
  const out = finish(s.read);
  const valid = Object.values(out.values).every((v) => WriteValueSchema.safeParse(v).success)
    && Object.values(out.refs).every((r) => (Array.isArray(r) ? r : [r]).every((x) => RefInputSchema.safeParse(x).success));
  return valid ? { kind: 'fill', values: out.values, refs: out.refs, fieldNotes: out.notes } : null;
}
