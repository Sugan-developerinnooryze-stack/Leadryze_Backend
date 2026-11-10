import type { Cond, QueryPlan, RefInput, WriteIntent, WriteValue } from './contracts/plan';
import type { FieldCap, FieldKind, ModuleCap, WriteFieldKind, WriteOptionsSource } from './registry/types';
import type { GrammarContext } from './grammar/context';
import type { FieldNote, FillFormSpec, WorkflowModule } from './writes/workflow-types';
import { getModuleCap } from './registry';
import { conditionOpsFor } from './registry/query-caps';
import { CustomFieldInfo, CustomModuleInfo, customFieldFor } from './registry/custom-modules';
import { toAsciiDigits } from './grammar/numbers';
import { MessageNumbers, NumberFacts, readNumbers } from './grammar/grounding-numbers';
import { BUSINESS_NUMBER_EXACT, BUSINESS_NUMBER_MODULES, tokenizeV1, tokenizeV1Spans } from './grammar/tokens';
import { FOCUS_WORDS, FOR_WORDS, ME_WORD, NAMED_WORDS } from './grammar/vocabulary';
import { DateTimeOptions, DateTimeSource, isDayKey, matchDateTimeAt, toWriteDate } from './grammar/dates';
import { writeCapFor } from './writes/write-caps';
import { escapeRegex } from '../../utils/escape-regex';

/* Grounding (plan 1.3): the planner may only copy free text and numbers from
 * the staff member's own message, never make them up. Before a planner plan
 * runs, every value it could have invented is looked for in the message:
 *
 *   text     plan.search, `contains` values on text fields, and eq / ne /
 *            in / nin values on text, id and reference fields: the value's
 *            words must appear in the message as a run of whole words. On
 *            text fields and in the search the last word may go on into a
 *            longer one ("kumar" is found in "Kumar's" and "Kumaran") when it
 *            has at least three letters (an Indic vowel sign or virama counts
 *            as one: "சிவா" in "சிவாவின்") and no digit, and a word ending in a
 *            virama (Tamil pulli) may take a case ending in its place
 *            ("குமார்" in "குமாருக்கு"); an id, a reference or "Phase 2" ends
 *            where the message's word ends. Both sides are read the same
 *            way: NFKC, digits of any script as ASCII, lower-case, and words
 *            of letters, combining marks and digits only, so Tamil and
 *            Devanagari words stay whole.
 *   record   record.number must be one of the business numbers the message
 *            writes, of the plan's module; it is then written as stored,
 *            upper-case ("9a218c-inv-0007" is 9A218C-INV-0007).
 *   numbers  conditions on number, money, percent and duration fields: the
 *            value must be a number the message writes, as
 *            grammar/grounding-numbers.ts reads them ("5 lakh", "५ लाख" and
 *            "5 லட்சம்" are 500000, "50k" and "fifty thousand" 50000,
 *            "between 10 and 20 lakh" holds 1000000, "५०००" is 5000). A
 *            planner that copied only the number before a multiplier ("5" of
 *            "5 lakh") gets the amount instead, when the number belongs to
 *            one amount and isn't written on its own as well; so does one
 *            that copied a number written with another time unit than a
 *            duration field's ("90" of "90 minutes" is 1.5 on a field kept
 *            in hours). Each such fix is reported.
 *   currency the field holding an amount's currency (deal.currency) may also
 *            hold the code of a currency written next to an amount ("$5000"
 *            gives USD).
 *   relation (Increment 5) the record a "for" relation names: its text
 *            must be in the message as text values are (whole words, the
 *            last may run on from three letters), and its id (entity.ref)
 *            only ever comes from this server, so the planner may only keep
 *            the last plan's. Text that points at the record on screen
 *            ("this customer", "that job", "it") is read as that record
 *            (entity { focus: true }), as the grammar reads "for this work
 *            order". The conditions of a has / has_none relation are the
 *            related module's, grounded against its fields as the plan's
 *            own conditions are (paths "relation.where.N.v").
 *   custom   (Increment 5) a Custom Module plan is grounded by its fields'
 *            kinds the same way: text values as text (a relationship field
 *            exactly, as a reference), number and currency values as
 *            numbers.
 *
 * A value that equals one the last plan holds at the same place (a
 * condition on the same field, the search, the record number, the record
 * the same relation names) counts as the message's too, so a follow-up
 * ("only the ones closing this month") keeps what the question before it
 * asked. The last plan is this server's own output, never the planner's.
 *
 * Enum, stage, outcome and state values, booleans, dates, field keys, the
 * module, sort, paging and "mine" are not matched against the text: the
 * plan validator and executor Q's compiler check them against the catalog
 * (schema enums, the tenant's stage keys and labels, RelRange), so a Tamil
 * question can still ask for the tenant's English stage "Qualified". Also
 * left as written, for the validator to refuse by name where leaving them
 * out would only widen the plan: a condition on a field the module doesn't
 * have, that no condition may use (hidden, PII) or whose stored unit isn't
 * settled (call.duration); an operator the field can't take ("contains" on
 * a stage); an in / nin with no values; and the relation itself, which is
 * never dropped (that would read every record instead of the related ones).
 *
 * What isn't found is dropped, never guessed: a condition (an in / nin
 * keeps the values that were found; a between needs both bounds), the
 * search or the record number. Every drop and every fix is reported so the
 * answer can say so. A plan that can't run without what isn't found is
 * refused whole instead (GroundedPlan.refused), and nothing is read: a
 * relation's record that isn't the message's (or the last plan's), or that
 * names no one record (words that only point, such as "them" or "these", or
 * a message about several parents: "invoices for customers in Chennai"), and
 * a record named by its id (record.ref), which only this server writes (a
 * duplicate number's choice, a related record). Pure: no database, no
 * clock.
 *
 * Increment 6: the planner's write intents and its answers to an open guided
 * form are grounded the same way (groundWriteIntent, groundFill, at the end
 * of this file). */

export interface GroundingDrop {
  /** Where in the plan, the write intent or the fill the value was ("search",
   * "where.1.v", "record.number", "values.title", "refs.customerId"). */
  path: string;
  /** The value as the planner wrote it (shown cut and with ids removed). */
  value: string;
}

/** A number the planner copied without what the message writes next to it,
 * replaced by the number the message means: "5" of "5 lakh" is 500000, and
 * "90" of "90 minutes" on a field kept in hours is 1.5. The answer says so. */
export interface GroundingFix {
  /** Where in the plan ("where.0.v", "where.1.v.0"). */
  path: string;
  /** The value as the planner wrote it. */
  value: string;
  /** The number used instead. */
  to: number;
  /** The unit of the duration field, for the note ("hours"). */
  unit?: string;
}

export interface GroundedPlan {
  plan: QueryPlan;
  dropped: GroundingDrop[];
  fixed: GroundingFix[];
  /** Set when the plan can't run without a value the message doesn't hold
   * (a relation's entity text, Increment 5), when that text names no one
   * record, or when the plan names a record by an id only the server writes
   * (record.ref; a relation's entity.ref other than the last plan's): the
   * plan is answered with the classic assistant choice and nothing is read.
   * `plan` is then the input, unchanged. */
  refused?: { path: string; value: string };
}

/** The module a plan reads, as grounding needs it: a registry entry or, for
 * a "custom:<slug>" target, the Custom Module (findCustomModule). Null for a
 * concept target (or a module nobody knows): then only the values that are
 * text whatever the field (search, contains, record number) are checked. */
export type GroundingModule = ModuleCap | CustomModuleInfo;

/** Field kinds whose condition values are free text. */
const TEXT_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['text', 'longtext', 'id', 'ref']);
/** Field kinds whose condition values are numbers. */
const NUMBER_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['number', 'money', 'percent', 'duration']);
/** A number written as text, as executor Q's compiler accepts it (compile.ts finiteNumber). */
const NUMERIC_TEXT = /^\s*-?\d+(\.\d+)?\s*$/;
/** Zero-width characters a keyboard may put inside a word (joiners in Indic scripts). */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/** The last word of a text value may go on into a longer word from this many
 * letters on ("Kum" in "Kumar", never "K"). An Indic vowel sign or virama
 * counts as a letter: "சிவா" (two consonants, two vowel signs) is a whole
 * name, "சி" is not. */
const RUN_ON_MIN_LETTERS = 3;
/** A word ending in a virama: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil (pulli), Telugu, Kannada, Malayalam, Sinhala. */
const VIRAMA_END = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u0DCA]$/u;
/** Words that point at records already in view instead of naming one. */
const POINTING_WORDS: ReadonlySet<string> = new Set(['this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their']);
/** Of those, the ones that alone point at the one record on screen ("show its invoices"). */
const ON_SCREEN_WORDS: ReadonlySet<string> = new Set(['this', 'that', 'it', 'its']);
/** A parent written in the plural after "for" or "of" may have this many words before it ("for our active customers"). */
const PLURAL_GAP_WORDS = 2;

/** Text as grounding (and the planner catalog) reads it: NFKC, digits of any
 * script as ASCII, lower-case, words of letters, combining marks and digits
 * one space apart. "Kumar's  INV-००७" -> "kumar s inv 007". */
export function matchableText(text: string): string {
  return toAsciiDigits(text.normalize('NFKC').replace(ZERO_WIDTH, ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/** A record number as it is stored and looked up: NFKC, digits of any
 * script as ASCII, trimmed, upper-case ("9a218c-inv-००07" -> "9A218C-INV-0007"). */
function canonicalNumber(text: string): string {
  return toAsciiDigits(text.normalize('NFKC')).trim().toUpperCase();
}

/** What a message offers to ground in: its words, business numbers and numbers. */
interface MessageFacts {
  /** matchableText(message), with a space on each side so a run of words is found at word starts and ends. */
  words: string;
  /** NFKC and lower-case only, for values with no letters or digits at all. */
  raw: string;
  /** The business numbers it writes, as stored ("9A218C-INV-0007"). */
  records: ReadonlySet<string>;
  numbers: MessageNumbers;
  /** The codes of the currencies it writes next to an amount ("$5000": USD). */
  currencies: ReadonlySet<string>;
}

function factsOf(message: string): MessageFacts {
  const numbers = readNumbers(message);
  return {
    words: ` ${matchableText(message)} `,
    raw: message.normalize('NFKC').toLowerCase(),
    records: new Set(tokenizeV1(message).flatMap((t) => (t.kind === 'number' ? [t.number] : []))),
    numbers,
    currencies: new Set(numbers.currencies.map((c) => c.currency)),
  };
}

/** What the last plan holds where a value is grounded: each condition
 * field's values (as text and as numbers), the search and the record number;
 * and, when it names the same relation (kind and module), that relation's
 * conditions and the record it is for. */
interface CarriedFacts {
  fields: CarriedFields;
  /** matchableText of its search. */
  search: string | null;
  /** Its record number, as stored. */
  record: string | null;
  /** The same relation's conditions (has / has_none), by field. */
  relationFields: CarriedFields;
  /** The same relation's record (for): matchableText of its text, its id in lower case. */
  entityText: string | null;
  entityRef: string | null;
}
type CarriedFields = ReadonlyMap<string, CarriedField>;
interface CarriedField {
  texts: ReadonlySet<string>;
  numbers: readonly number[];
}

function carriedFields(conds: readonly Cond[] | undefined): CarriedFields {
  const fields = new Map<string, { texts: Set<string>; numbers: number[] }>();
  for (const cond of conds ?? []) {
    if (!('f' in cond) || !('v' in cond)) continue;
    let field = fields.get(cond.f);
    if (!field) fields.set(cond.f, (field = { texts: new Set(), numbers: [] }));
    for (const value of Array.isArray(cond.v) ? cond.v : [cond.v]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const words = matchableText(String(value));
      if (words) field.texts.add(words);
      const n = numericValue(value);
      if (n !== null) field.numbers.push(n);
    }
  }
  return fields;
}

/** `relation` is the plan's: the last plan's relation counts only when it is the same one. */
function carriedFacts(carried: QueryPlan | undefined, relation: QueryPlan['relation']): CarriedFacts {
  const search = carried?.search === undefined ? '' : matchableText(carried.search);
  const record = carried?.record && 'number' in carried.record ? canonicalNumber(carried.record.number) : '';
  const last = carried?.relation;
  const same = !!last && !!relation && last.kind === relation.kind && last.name === relation.name ? last : undefined;
  const entity = same?.kind === 'for' ? same.entity : undefined;
  const entityText = entity && 'text' in entity ? matchableText(entity.text) : '';
  return {
    fields: carriedFields(carried?.where),
    search: search || null,
    record: record || null,
    relationFields: carriedFields(same && same.kind !== 'for' ? same.where : undefined),
    entityText: entityText || null,
    entityRef: entity && 'ref' in entity ? entity.ref.toLowerCase() : null,
  };
}

/** How the words of a text value must sit in the message (textFound). */
type TextMatch = 'exact' | 'run_on';

/** The value's words appear in the message as a run of whole words. With
 * `run_on` the last of them may go on into a longer word when it has at
 * least three letters, vowel signs counted (RUN_ON_MIN_LETTERS), and no digit
 * ("kumar" in "kumars", "Kum" in "Kumar", "சிவா" in "சிவாவின்"; never "K",
 * nor "INV-001" in "INV-0012"), or, ending in a virama, take a vowel sign in
 * the virama's place ("குமார்" in "குமாருக்கு", "ராமன்" in "ராமனுடைய", "ராம்"
 * in "ராமின்"). A value with no letters or digits at all must appear as
 * written; a blank one invents nothing (the validator refuses a blank
 * condition). */
function textFound(value: string, facts: MessageFacts, match: TextMatch): boolean {
  const words = matchableText(value);
  if (!words) {
    const raw = value.normalize('NFKC').toLowerCase().trim();
    return !raw || facts.raw.includes(raw);
  }
  if (facts.words.includes(` ${words} `)) return true;
  if (match === 'exact') return false;
  const last = words.slice(words.lastIndexOf(' ') + 1);
  if (/\p{N}/u.test(last) || (last.match(/[\p{L}\p{M}]/gu) ?? []).length < RUN_ON_MIN_LETTERS) return false;
  if (facts.words.includes(` ${words}`)) return true;
  return VIRAMA_END.test(words) && new RegExp(` ${escapeRegex(words.slice(0, -1))}\\p{M}`, 'u').test(facts.words);
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** A condition value as a number, when it is one (a number, or numeric text). */
function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_TEXT.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** How one condition's values are looked for in the message. */
type Reading =
  | { as: 'text'; match: TextMatch; currency: boolean }
  | { as: 'number'; numbers: NumberFacts; unit?: string };

/** A `contains` on a concept target's field: free text whatever the field. */
const FREE_TEXT: Reading = { as: 'text', match: 'run_on', currency: false };

/** The field holds the currency of one of the module's amounts (deal.currency of deal.amount). */
function holdsCurrency(cap: ModuleCap, field: FieldCap): boolean {
  return cap.fields.some((f) => f.kind === 'money' && typeof f.money?.currency === 'object' && f.money.currency.field === field.key);
}

/** How a condition on this field is grounded: as text (an id or a
 * reference exactly; an amount's currency field also by the currencies
 * written next to amounts), or as the numbers its kind reads (money, a
 * duration in its unit, any other number). Null for every other kind
 * (enum, stage, date, boolean), which the validator and compiler check. */
function readingFor(cap: ModuleCap, field: FieldCap, facts: MessageFacts): Reading | null {
  if (TEXT_KINDS.has(field.kind)) {
    return { as: 'text', match: field.kind === 'id' || field.kind === 'ref' ? 'exact' : 'run_on', currency: holdsCurrency(cap, field) };
  }
  if (!NUMBER_KINDS.has(field.kind)) return null;
  if (field.kind === 'duration' && field.unit) return { as: 'number', numbers: facts.numbers.durationIn(field.unit), unit: field.unit };
  return { as: 'number', numbers: field.kind === 'money' ? facts.numbers.money : facts.numbers.other };
}

/** The same for a Custom Module field (registry/custom-modules.ts kinds):
 * text as text, a relationship (which holds another record's number)
 * exactly, as a reference; a number as a number, a currency field as money.
 * Null for choices, dates and yes/no, which validateCustomPlan checks
 * against the definition. */
function customReadingFor(field: CustomFieldInfo, facts: MessageFacts): Reading | null {
  if (field.kind === 'number') return { as: 'number', numbers: field.fieldType === 'currency' ? facts.numbers.money : facts.numbers.other };
  if (field.kind !== 'text') return null;
  return { as: 'text', match: field.fieldType === 'relationship' ? 'exact' : 'run_on', currency: false };
}

/** How a condition on a field is grounded: its reading; null when its values
 * aren't matched against the text; 'validator' when the validator refuses
 * the condition by name whatever its value, so it is left as written: a
 * field the module doesn't have, one no condition may use (hidden, PII), or
 * one whose stored unit isn't settled (call.duration). */
type FieldReader = (field: string, op: Cond['op']) => Reading | null | 'validator';

function readerFor(module: GroundingModule | null, facts: MessageFacts): FieldReader {
  // No module (a concept target): only `contains` is text whatever the field.
  if (!module) return (_field, op) => (op === 'contains' ? FREE_TEXT : null);
  if ('slug' in module) {
    return (key) => {
      const field = customFieldFor(module, key);
      return field && field.ops.length ? customReadingFor(field, facts) : 'validator';
    };
  }
  return (key) => {
    const field = module.fields.find((f) => f.key === key);
    if (!field || conditionOpsFor(module, field).length === 0 || field.unitUncertain) return 'validator';
    return readingFor(module, field, facts);
  };
}

/** Whether one value of a condition is the message's, or the last plan's
 * at the same place: true, false, or the number the message means where
 * the planner copied only its base ("5" of "5 lakh"; "90" of "90 minutes"
 * on a field in hours), when that base belongs to one amount and isn't
 * written on its own as well. Values that aren't free text or a number for
 * that field (a boolean on a text field, a date on a number field) are
 * left to the plan validator, which names them. */
function groundValue(reading: Reading, value: unknown, facts: MessageFacts, carried: CarriedField | undefined): boolean | number {
  if (reading.as === 'number') {
    const n = numericValue(value);
    if (n === null) return true;
    const same = (m: number) => sameNumber(m, n);
    if (reading.numbers.plain.some(same) || carried?.numbers.some(same)) return true;
    const amounts = reading.numbers.bases.filter((b) => same(b.base)).map((b) => b.value);
    const distinct = amounts.filter((a, i) => amounts.findIndex((b) => sameNumber(a, b)) === i);
    return distinct.length === 1 ? distinct[0] : false;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return true;
  const text = String(value);
  if (textFound(text, facts, reading.match)) return true;
  if (reading.currency && facts.currencies.has(text.trim().toUpperCase())) return true;
  const words = matchableText(text);
  return !!words && !!carried?.texts.has(words);
}

function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

/** The condition with only what the message holds, or null when nothing of
 * it is left; a number the planner copied without its multiplier or time
 * unit is replaced by the message's (each fix noted in `fixed`). */
function groundCondition(
  reader: FieldReader, cond: Cond, at: string, facts: MessageFacts, carried: CarriedFields,
  dropped: GroundingDrop[], fixed: GroundingFix[],
): Cond | null {
  if (!('f' in cond)) return cond;
  // The validator refuses the condition by name, found or not (readerFor).
  const reading = reader(cond.f, cond.op);
  if (reading === 'validator' || !reading) return cond;
  const last = carried.get(cond.f);
  const fixes: GroundingFix[] = [];
  // The value as grounded, or null when it isn't the message's (the drop is noted).
  const ground = (value: unknown, path: string): { value: unknown } | null => {
    const found = groundValue(reading, value, facts, last);
    if (found === false) {
      dropped.push({ path, value: shown(value) });
      return null;
    }
    if (found === true) return { value };
    fixes.push({ path, value: shown(value), to: found, ...(reading.as === 'number' && reading.unit ? { unit: reading.unit } : {}) });
    return { value: found };
  };
  // The condition runs, so its fixes stand.
  const kept = (grounded: Cond): Cond => {
    fixed.push(...fixes);
    return grounded;
  };

  switch (cond.op) {
    case 'contains':
      // Only text has words to look for; on any other field the validator refuses the operator.
      if (reading.as !== 'text') return cond;
      return ground(cond.v, `${at}.v`) ? cond : null;
    case 'eq': case 'ne': {
      const one = ground(cond.v, `${at}.v`);
      return one ? kept(fixes.length ? { ...cond, v: one.value } as Cond : cond) : null;
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      // Only numbers are compared; on any other field the validator refuses the operator.
      if (reading.as !== 'number') return cond;
      const one = ground(cond.v, `${at}.v`);
      return one ? kept(fixes.length ? { ...cond, v: one.value } as Cond : cond) : null;
    }
    case 'in': case 'nin': {
      // No values at all: the validator refuses it by name, where leaving it out would only widen the plan.
      if (!cond.v.length) return cond;
      const values = cond.v.flatMap((value, i) => {
        const one = ground(value, `${at}.v.${i}`);
        return one ? [one.value] : [];
      });
      if (!values.length) return null;
      return kept(values.length === cond.v.length && !fixes.length ? cond : { ...cond, v: values } as Cond);
    }
    case 'between': {
      if (reading.as !== 'number') return cond;
      const bounds = cond.v.map((bound, i) => ground(bound, `${at}.v.${i}`));
      // A between needs both bounds.
      if (!bounds[0] || !bounds[1]) return null;
      return kept(fixes.length ? { ...cond, v: [bounds[0].value, bounds[1].value] } as Cond : cond);
    }
    default:
      return cond;
  }
}

/** The record number as stored, when the message (or the last plan) writes
 * it and it is one of the plan's module; null otherwise. Business numbers
 * are stored upper-case and looked up exactly, so one the message only
 * starts with ("…-INV-001" of "…-INV-0012") or writes otherwise ("9a218c
 * inv 0007", "INV-0007") is not there. */
function recordNumber(module: GroundingModule | null, value: string, facts: MessageFacts, carried: CarriedFacts): string | null {
  const number = canonicalNumber(value);
  if (!facts.records.has(number) && number !== carried.record) return null;
  const code = BUSINESS_NUMBER_EXACT.exec(number)?.[2];
  if (!code || (module && BUSINESS_NUMBER_MODULES[code] !== module.key)) return null;
  return number;
}

/** The conditions that are left once each is grounded (groundCondition). */
function groundConditions(
  reader: FieldReader, conds: readonly Cond[], at: string, facts: MessageFacts, carried: CarriedFields,
  dropped: GroundingDrop[], fixed: GroundingFix[],
): Cond[] {
  return conds
    .map((cond, i) => groundCondition(reader, cond, `${at}.${i}`, facts, carried, dropped, fixed))
    .filter((cond): cond is Cond => cond !== null);
}

/** A module's own words as grounding reads them: its labels and synonyms. */
function moduleWords(cap: ModuleCap): string[] {
  return [...new Set([cap.labels.singular, cap.labels.plural, ...cap.labels.synonyms].map(matchableText).filter(Boolean))];
}

/** Its words in the plural: those whose last word, less "s", "es" or "ies"
 * (as "y"), is another of its words ("customers", "work orders",
 * "companies"), as the grammar tells a plural (parse.ts isPluralModule). */
function pluralWords(cap: ModuleCap): string[] {
  const words = moduleWords(cap);
  return words.filter((phrase) => {
    const at = phrase.lastIndexOf(' ') + 1;
    const last = phrase.slice(at);
    const stems = [
      ...(last.endsWith('ies') ? [`${last.slice(0, -3)}y`] : []),
      ...(last.endsWith('es') ? [last.slice(0, -2)] : []),
      ...(last.endsWith('s') ? [last.slice(0, -1)] : []),
    ];
    return stems.some((stem) => words.includes(phrase.slice(0, at) + stem));
  });
}

/** A "for" relation's text that points at the record on screen instead of
 * naming one, as the grammar reads "for this work order": "this" or "that"
 * before the parent module's own word ("this customer", "that job", "this
 * customer's"), or "this", "that", "it" or "its" alone ("show its
 * invoices"). Searched as a name, such a word would match inside other names
 * ("this" in "Sathish", "it" in "Smith"). A word of another module ("this
 * work order" for a customer) is left to the normal path. */
function pointsAtScreen(text: string, parent: ModuleCap | undefined): boolean {
  const words = matchableText(text).split(' ');
  if (words.length === 1) return ON_SCREEN_WORDS.has(words[0]);
  if (!parent || !FOCUS_WORDS.has(words[0])) return false;
  return moduleWords(parent).includes(words.slice(1).join(' ').replace(/ s$/, ''));
}

/** The plan with a "for" relation's text that points at the record on
 * screen read as that record (entity { focus: true }): the record page the
 * staff member is on, else the record an earlier card showed, read again
 * under their scope; with neither, they are asked which one. Nothing to
 * report: the answer's chip names the record it used. */
function withScreenRecord(plan: QueryPlan): QueryPlan {
  const rel = plan.relation;
  if (rel?.kind !== 'for' || !('text' in rel.entity) || !pointsAtScreen(rel.entity.text, getModuleCap(rel.name))) return plan;
  return { ...plan, relation: { kind: 'for', name: rel.name, entity: { focus: true } } };
}

/** The message asks about the records of several parents, which a "for"
 * relation (one record) can't hold: "for" or "of", at most two more words,
 * then the parent module in the plural ("invoices for customers in Chennai",
 * "work orders of our active customers", "invoices for these customers"),
 * unless "named" or "called" follows ("for customers named ABC" names one).
 * The grammar leaves these to the planner for the same reason. Compared word
 * by word, so no regex is built from the module's words. */
function asksForSeveral(parent: ModuleCap | undefined, facts: MessageFacts): boolean {
  const plurals = parent ? pluralWords(parent).map((phrase) => phrase.split(' ')) : [];
  if (!plurals.length) return false;
  const words = facts.words.trim().split(' ');
  return words.some((word, at) => FOR_WORDS.has(word) && Array.from({ length: PLURAL_GAP_WORDS + 1 }, (_, gap) => at + 1 + gap)
    .some((start) => plurals.some((plural) => plural.every((w, k) => words[start + k] === w) && !NAMED_WORDS.has(words[start + plural.length]))));
}

/** Why the plan can't run as the planner wrote it, if it can't: it names a
 * record by its id (record.ref, which only this server writes), or its
 * relation's record isn't the message's: an id other than the one the last
 * plan's same relation holds (this server wrote that one), or text the
 * message doesn't hold as a name (whole words, the last may run on from three
 * letters) nor the last plan. Leaving such a relation out would read every
 * record instead of the related ones, so nothing runs. Nor does text that
 * names no one record: words that only point ("them", "these") or a message
 * about several parents (asksForSeveral); searched as a name, it would show
 * one record whose name happens to hold the words. */
function refusalOf(plan: QueryPlan, facts: MessageFacts, last: CarriedFacts): GroundedPlan['refused'] {
  if (plan.record && 'ref' in plan.record) return { path: 'record.ref', value: plan.record.ref };
  if (plan.relation?.kind !== 'for') return undefined;
  const entity = plan.relation.entity;
  if ('ref' in entity && entity.ref.toLowerCase() !== last.entityRef) return { path: 'relation.entity.ref', value: entity.ref };
  if (!('text' in entity)) return undefined;
  const refused = { path: 'relation.entity.text', value: entity.text };
  if (!textFound(entity.text, facts, 'run_on') && matchableText(entity.text) !== last.entityText) return refused;
  const words = matchableText(entity.text).split(' ');
  if (words.every((word) => POINTING_WORDS.has(word)) || asksForSeveral(getModuleCap(plan.relation.name), facts)) return refused;
  return undefined;
}

/** The plan with every free-text value and number it could have invented
 * checked against `message` and, place by place, against `carried`, the
 * conversation's last plan when it is about the same module (see above);
 * what was dropped; the numbers read from the message in place of the
 * planner's; and, when the plan can't run without what isn't found, why it
 * is refused (the plan is then returned as given). `module` is the plan's
 * module: a registry entry, the Custom Module of a "custom:<slug>" target,
 * or null for a concept target, when only the values that are text whatever
 * the field (search, contains, record number) are checked. A relation's
 * conditions are grounded against its related module (registry), and the
 * relation itself is never dropped; a "for" relation's text that points at
 * the record on screen becomes that record (withScreenRecord). The input
 * plan is not changed. */
export function groundPlan(module: GroundingModule | null, plan: QueryPlan, message: string, carried?: QueryPlan): GroundedPlan {
  const facts = factsOf(message);
  const input = withScreenRecord(plan);
  const last = carriedFacts(carried, input.relation);
  const refused = refusalOf(input, facts, last);
  if (refused) return { plan: { ...plan }, dropped: [], fixed: [], refused };
  const dropped: GroundingDrop[] = [];
  const fixed: GroundingFix[] = [];
  const out: QueryPlan = { ...input };

  if (out.search !== undefined && !textFound(out.search, facts, 'run_on') && matchableText(out.search) !== last.search) {
    dropped.push({ path: 'search', value: out.search });
    delete out.search;
  }
  if (out.record && 'number' in out.record) {
    const number = recordNumber(module, out.record.number, facts, last);
    if (number === null) {
      dropped.push({ path: 'record.number', value: out.record.number });
      delete out.record;
    } else if (number !== out.record.number) {
      out.record = { number };
    }
  }
  if (out.where) {
    const where = groundConditions(readerFor(module, facts), out.where, 'where', facts, last.fields, dropped, fixed);
    if (where.length) out.where = where;
    else delete out.where;
  }
  // has / has_none: the conditions are the related (child) module's, named by the relation.
  const relation = out.relation;
  if (relation && relation.kind !== 'for' && relation.where) {
    const related = getModuleCap(relation.name) ?? null;
    const where = groundConditions(readerFor(related, facts), relation.where, 'relation.where', facts, last.relationFields, dropped, fixed);
    out.relation = { kind: relation.kind, name: relation.name, ...(where.length ? { where } : {}) };
  }
  return { plan: out, dropped, fixed };
}

/** The currencies the message writes next to an amount ("$5000", "5 lakh rupees"), as ISO codes, each once. */
export function writtenCurrencies(message: string): string[] {
  return [...new Set(readNumbers(message).currencies.map((c) => c.currency))];
}

/** The currency the message writes next to this amount ("over $5000": USD
 * for 5000), or null when it writes none there, or two different ones. */
export function writtenCurrencyFor(message: string, amount: number): string | null {
  const codes = new Set(readNumbers(message).currencies.filter((c) => sameNumber(c.value, amount)).map((c) => c.currency));
  return codes.size === 1 ? [...codes][0] : null;
}

/* ── Write intents and fills (Increment 6) ─────────────────────────────────
 * The planner's write intent (groundWriteIntent) and its answer to the
 * guided form open in the chat (groundFill) are grounded as a plan is:
 * whatever the planner could have invented must be in the message.
 *
 *   ids      a record named by its id (target.ref) or a record the change is
 *            made from (from): only this server writes those, so the intent
 *            is refused whole. A record field given an id, the record on
 *            screen or "me" ({ref}, {focus}, {me}) and catalog lines are
 *            dropped: the planner may only copy words.
 *   from     (Increment 7) a create made from another record keeps it when
 *            it is a record number of the module its form is made from
 *            (WorkflowModule.source: an invoice's work order) that the
 *            message writes, as stored; by an id, the record on screen, or
 *            any other number, the intent is refused, as above.
 *   target   an update's or a delete's record: its words must be the
 *            message's, else the intent is refused (left out, the change
 *            would fall on the record on screen). Words that point at the
 *            record on screen ("this job", "it") are that record; words that
 *            only point ("them") name no one record (refused). A record
 *            number must be one the message writes, of the module, and is
 *            written as stored. A create's target names what is created:
 *            its words go to the record field "for" names (WriteCap.forRef)
 *            when the message writes them right after "for"; else to the
 *            primary text (title, subject, name; a person's first name, the
 *            rest as the last name) when the planner gave none; else to the
 *            "for" field while it is free; else they are dropped.
 *   keys     only the form's fields: values for those the planner may fill
 *            (plannerFillOf), refs for its record fields. A record field
 *            given words as a value is named in refs.
 *   words    a record's name and a text value: its words in the message
 *            (textFound; an email or phone number exactly). "me" on a staff
 *            or owner field is the caller ({ me: true }); words that point at
 *            the record on screen are it, on a field for its module.
 *   numbers  one the message writes (readNumbers); the base of a multiplied
 *            amount ("5" of "5 lakh") is the amount.
 *   choices  an enum or stage value must be one of the field's options (its
 *            value, or its value or label with case and spacing aside) and
 *            is written as the option; it is never looked for in the
 *            message. Options not known here (a write intent's stages with
 *            no grammar context) are left for the form to check.
 *   dates    the planner's own date is never used: the first date-time
 *            phrase of the message is read again (grammar/dates.ts, in the
 *            tenant's day and zone) for the first date field it filled, in
 *            the form's order, with the note when the field can't take all
 *            of it (L14: a day without a time, an hour without am or pm,
 *            midnight). Another date field, a message with no date-time, or
 *            no grammar context: the value is dropped.
 *
 * What isn't found is dropped, never guessed, and every drop is reported.
 * Pure, as above: the WriteCaps and the grammar context are all it reads. */

/** What write grounding needs of a guided form's field. */
interface GroundField {
  kind: WriteFieldKind;
  /** value: the planner may fill it; ref: a record field, named in refs (plannerFillOf). */
  fill: 'value' | 'ref' | null;
  /** The modules a record field names ('user' for an owner). */
  modules: readonly string[];
  /** A choice's options, when they are known here. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** A field for a day to come: a year-less day already past is next year's. */
  future: boolean;
}

/** What grounding keeps of a write intent's or a fill's values and refs, how
 * the dates were read, and what it drops. */
interface WriteGrounding {
  values: Record<string, WriteValue>;
  refs: Record<string, RefInput | RefInput[]>;
  fieldNotes: Record<string, FieldNote>;
  dropped: GroundingDrop[];
}

/** Field kinds that name records: never a value, always named in refs. */
const RECORD_KINDS: ReadonlySet<WriteFieldKind> = new Set<WriteFieldKind>(['ref', 'ref_many', 'related', 'owner_user']);
const CUSTOM_PREFIX = 'customFields.';
/** The longest name a reference takes (RefInputSchema). */
const MAX_REF_TEXT = 100;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** How the planner may answer a field of a guided form: 'value' for one it
 * may fill (the WriteCap's plannerFillable; a tenant custom field unless it
 * is a list of choices, as operations/prefill.ts makes it), 'ref' for a
 * record field of the WriteCap, named in refs; null for any other (a work
 * order's address is prefilled, never the planner's). */
export function plannerFillOf(module: string, field: { key: string; kind: WriteFieldKind }): 'value' | 'ref' | null {
  const cap = writeCapFor(module);
  if (!cap) return null;
  if (field.key.startsWith(CUSTOM_PREFIX)) {
    return cap.customFields && !RECORD_KINDS.has(field.kind) && field.kind !== 'multiselect' ? 'value' : null;
  }
  const own = cap.fields.find((f) => f.key === field.key);
  if (!own || own.kind !== field.kind) return null;
  if (RECORD_KINDS.has(own.kind)) return 'ref';
  return own.plannerFillable ? 'value' : null;
}

/** An enum's values: a static list, or the model's own enum at the key (the
 * registry's introspected schema, else the schema path). None for a stage. */
function enumValuesOf(module: string, key: string, source: WriteOptionsSource | undefined): string[] {
  if (source?.from === 'static') return source.values.filter((v) => typeof v === 'string' && v !== '');
  if (source?.from !== 'schema') return [];
  const cap = getModuleCap(module);
  const known = cap?.fields.find((f) => !f.virtual && (f.path === key || f.key === key))?.schema?.enumValues;
  if (known?.length) return [...known];
  try {
    const values: unknown = (cap?.model().schema.path(key) as { enumValues?: unknown } | undefined)?.enumValues;
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v !== '') : [];
  } catch {
    return [];
  }
}

/** A stage field's options: the tenant's stages as the grammar context holds them; unknown without them. */
function stageOptionsOf(module: string, ctx: GrammarContext | undefined): Array<{ value: string; label: string }> | undefined {
  const stages = ctx?.moduleInfo?.(module)?.stages ?? [];
  return stages.length ? stages.map((s) => ({ value: s.key, label: s.label })) : undefined;
}

/** A write intent's fields: the WriteCap's for its operation (a delete has none). */
function intentFields(wf: WorkflowModule, op: WriteIntent['op'], ctx: GrammarContext | undefined): Map<string, GroundField> {
  const fields = new Map<string, GroundField>();
  if (op === 'delete') return fields;
  for (const f of wf.cap.fields) {
    if (!f.ops.includes(op)) continue;
    const values = f.kind === 'enum' || f.kind === 'multiselect' ? enumValuesOf(wf.cap.module, f.key, f.options) : [];
    const options = f.kind === 'stage' ? stageOptionsOf(wf.cap.module, ctx) : values.length ? values.map((value) => ({ value, label: value })) : undefined;
    fields.set(f.key, {
      kind: f.kind,
      fill: RECORD_KINDS.has(f.kind) ? 'ref' : f.plannerFillable ? 'value' : null,
      modules: f.kind === 'owner_user' ? ['user'] : f.related ? [...f.related.modules] : f.ref ? [f.ref.module] : [],
      ...(options ? { options } : {}),
      future: !!f.future,
    });
  }
  return fields;
}

/** The open form's fields (formSpecFor), each with how the planner may answer it. */
function fillFields(spec: FillFormSpec, ctx: GrammarContext): Map<string, GroundField> {
  return new Map(spec.fields.map((f): [string, GroundField] => {
    const options = f.kind === 'stage' ? stageOptionsOf(spec.module, ctx) : f.options?.length ? f.options : undefined;
    return [f.key, { kind: f.kind, fill: plannerFillOf(spec.module, f), modules: f.refModules ?? [], ...(options ? { options } : {}), future: !!f.future }];
  }));
}

/** A staff or owner field, which "me" fills with the caller. */
function takesMe(field: GroundField): boolean {
  return field.kind === 'owner_user' || ((field.kind === 'ref' || field.kind === 'ref_many') && field.modules.includes('staff'));
}

/** The record a field's words name, when they are the message's: "me" on a
 * staff or owner field is the caller; words that point at the record on
 * screen are it, on a field for its module; other words are a name the form
 * looks up. Null when the words aren't the message's, name no one record
 * ("them"), or are longer than a name. */
function namedRef(field: GroundField, text: string, facts: MessageFacts): RefInput | null {
  const words = matchableText(text);
  if (!words || text.length > MAX_REF_TEXT || !textFound(text, facts, 'run_on')) return null;
  if (words === ME_WORD) return takesMe(field) ? { me: true } : null;
  if (field.modules.some((module) => {
    const cap = getModuleCap(module);
    return !!cap && pointsAtScreen(text, cap);
  })) return { focus: true };
  return words.split(' ').every((word) => POINTING_WORDS.has(word)) ? null : { text };
}

/** A choice value as one of the field's options (its value; or its value or
 * label, case and spacing aside), written as the option's value; as written
 * when the options aren't known here (the form checks it); else null. */
function optionOf(field: GroundField, value: unknown): string | null {
  if (typeof value !== 'string' || !matchableText(value)) return null;
  if (!field.options) return value;
  const words = matchableText(value);
  const hit = field.options.find((o) => o.value === value)
    ?? field.options.find((o) => matchableText(o.value) === words || matchableText(o.label) === words);
  return hit ? hit.value : null;
}

/** A number the message writes, or the amount whose base the planner copied
 * ("5" of "5 lakh" is 500000) when the base belongs to one amount; else null. */
function writtenNumber(value: WriteValue, numbers: NumberFacts): number | null {
  const n = numericValue(value);
  if (n === null) return null;
  if (numbers.plain.some((m) => sameNumber(m, n))) return n;
  const amounts = numbers.bases.filter((b) => sameNumber(b.base, n)).map((b) => b.value);
  const distinct = amounts.filter((a, i) => amounts.findIndex((b) => sameNumber(a, b)) === i);
  return distinct.length === 1 ? distinct[0] : null;
}

/** A value the planner wrote for a field it may fill (dates aside), as
 * grounded; null when it isn't the message's or isn't one of the options. */
function groundedValue(field: GroundField, value: WriteValue, facts: MessageFacts): WriteValue | null {
  switch (field.kind) {
    case 'text': case 'longtext': case 'email': case 'phone': {
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return null;
      return textFound(String(value), facts, field.kind === 'email' || field.kind === 'phone' ? 'exact' : 'run_on') ? value : null;
    }
    case 'number': case 'percent':
      return writtenNumber(value, facts.numbers.other);
    case 'money':
      return writtenNumber(value, facts.numbers.money);
    case 'enum': case 'stage':
      return optionOf(field, value);
    case 'multiselect': {
      if (typeof value !== 'string') return null;
      const picked = value.split(',').map((part) => optionOf(field, part.trim()));
      return picked.every((option): option is string => option !== null) ? [...new Set(picked)].join(', ') : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    default:
      return null;
  }
}

/** The first date-time phrase of the message (grammar/dates.ts), as a date
 * or datetime field takes it (toWriteDate), with the note when it can't take
 * all of it. On a datetime field an hour without am or pm, and midnight,
 * keep only the day (L14: never guessed, never written). Null without the
 * grammar context's day, or when the message writes no date-time. */
function firstDateTimeOf(message: string, ctx: GrammarContext | undefined, kind: 'date' | 'datetime', future: boolean):
  { value?: WriteValue; note?: FieldNote } | null {
  const todayKey = ctx?.todayKey;
  if (!isDayKey(todayKey)) return null;
  const { tokens, spans, text } = tokenizeV1Spans(message);
  const src: DateTimeSource = { toks: tokens.map((t) => (t.kind === 'word' ? t : undefined)), spans, text };
  const opts: DateTimeOptions = { todayKey, future, ...(ctx?.now ? { now: ctx.now } : {}), ...(ctx?.timezone ? { timezone: ctx.timezone } : {}) };
  for (let i = 0; i < tokens.length; i += 1) {
    const m = matchDateTimeAt(src, i, opts);
    if (!m) continue;
    return kind === 'datetime' && m.value.kind === 'day_time' && m.note ? { value: { date: m.value.date }, note: m.note } : toWriteDate(m.value, kind);
  }
  return null;
}

/** A value as a drop shows it: a date-time as its day and time, a relative day as its words, else as written. */
function shownValue(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { date?: unknown; time?: unknown; rel?: unknown };
    if (typeof v.date === 'string') return typeof v.time === 'string' ? `${v.date} ${v.time}` : v.date;
    if (typeof v.rel === 'string') return v.rel.replace(/_/g, ' ');
  }
  return shown(value);
}

/** A reference as a drop shows it: its words or its id; the record on screen and "me" as nothing. */
function shownRef(input: RefInput): string {
  return 'text' in input ? input.text : 'ref' in input ? input.ref : '';
}

/** A write intent's or a fill's values and refs grounded against the form's
 * fields (see above), into `out`. refs first, so a record field given words
 * as a value is named only when refs left it unnamed. */
function groundFields(
  fields: ReadonlyMap<string, GroundField>, values: Record<string, WriteValue> | undefined,
  refs: Record<string, RefInput | RefInput[]> | undefined, message: string, ctx: GrammarContext | undefined,
  facts: MessageFacts, out: WriteGrounding,
): void {
  for (const [key, input] of Object.entries(refs ?? {})) {
    const field = fields.get(key);
    const kept: RefInput[] = [];
    (Array.isArray(input) ? input : [input]).forEach((one, i) => {
      const named = field?.fill === 'ref' && 'text' in one ? namedRef(field, one.text, facts) : null;
      if (named) kept.push(named);
      else out.dropped.push({ path: Array.isArray(input) ? `refs.${key}.${i}` : `refs.${key}`, value: shownRef(one) });
    });
    if (kept.length) out.refs[key] = Array.isArray(input) ? kept : kept[0];
  }
  const dates: string[] = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    const field = fields.get(key);
    const drop = (): void => { out.dropped.push({ path: `values.${key}`, value: shownValue(value) }); };
    if (!field || field.fill === null) {
      drop();
    } else if (field.fill === 'ref') {
      const named = !hasOwn(out.refs, key) && (typeof value === 'string' || typeof value === 'number') ? namedRef(field, String(value), facts) : null;
      if (named) out.refs[key] = named;
      else drop();
    } else if (field.kind === 'date' || field.kind === 'datetime') {
      dates.push(key);
    } else {
      const grounded = groundedValue(field, value, facts);
      if (grounded === null) drop();
      else out.values[key] = grounded;
    }
  }
  // The first date field the planner filled, in the form's order, takes the
  // message's first date-time phrase; another one can't be told apart.
  [...fields.keys()].filter((key) => dates.includes(key)).forEach((key, i) => {
    const field = fields.get(key)!;
    const read = i === 0 ? firstDateTimeOf(message, ctx, field.kind === 'datetime' ? 'datetime' : 'date', field.future) : null;
    if (read?.value !== undefined) out.values[key] = read.value;
    else out.dropped.push({ path: `values.${key}`, value: shownValue(values?.[key]) });
    if (read?.note) out.fieldNotes[key] = read.note;
  });
}

/** The record number as stored, when the message writes it and it is one of `module`'s; else null. */
function writtenRecordNumber(module: string, value: string, facts: MessageFacts): string | null {
  const number = canonicalNumber(value);
  const code = BUSINESS_NUMBER_EXACT.exec(number)?.[2];
  return facts.records.has(number) && !!code && BUSINESS_NUMBER_MODULES[code] === module ? number : null;
}

/** A create's "from" as grounded (Increment 7): a record number of the
 * module its form is made from (WorkflowModule.source), written in the
 * message, as stored. null for any other: an id or the record on screen
 * (only this server writes those), another module's number, or one the
 * message doesn't write. */
function groundedFrom(intent: WriteIntent, wf: WorkflowModule, facts: MessageFacts): { module: string; number: string } | null {
  const { from } = intent;
  if (intent.op !== 'create' || !from || !('number' in from) || wf.source?.module !== from.module) return null;
  const number = writtenRecordNumber(from.module, from.number, facts);
  return number ? { module: from.module, number } : null;
}

/** Why a write intent can't run as the planner wrote it, if it can't: it
 * names a record by its id (target.ref), or a record the change is made from
 * (from) other than as groundedFrom keeps it; or an update's or delete's
 * record isn't the message's: a number it doesn't write (of the module),
 * words it doesn't hold, or words that name no one record ("them"). */
function writeRefusalOf(intent: WriteIntent, kept: ReturnType<typeof groundedFrom>, facts: MessageFacts): { path: string; value: string } | undefined {
  const { from, target } = intent;
  if (from && !kept) return { path: 'from', value: 'ref' in from ? from.ref : 'number' in from ? from.number : '' };
  if (!target || 'focus' in target) return undefined;
  if ('ref' in target) return { path: 'target.ref', value: target.ref };
  if (intent.op === 'create') return undefined;
  if ('number' in target) {
    return writtenRecordNumber(intent.module, target.number, facts) ? undefined : { path: 'target.number', value: target.number };
  }
  const words = matchableText(target.text);
  if (!words || !textFound(target.text, facts, 'run_on')) return { path: 'target.text', value: target.text };
  if (pointsAtScreen(target.text, getModuleCap(intent.module))) return undefined;
  return words.split(' ').every((word) => POINTING_WORDS.has(word)) ? { path: 'target.text', value: target.text } : undefined;
}

/** An update's or delete's record as grounded (writeRefusalOf passed it):
 * words pointing at the record on screen are it; a number as stored. */
function targetOf(intent: WriteIntent): WriteIntent['target'] {
  const target = intent.target;
  if (!target) return undefined;
  if ('text' in target && pointsAtScreen(target.text, getModuleCap(intent.module))) return { focus: true };
  if ('number' in target) return { number: canonicalNumber(target.number) };
  return target;
}

/** A create's target names what is created (see above): the record "for"
 * names, the primary text, or nothing. Words the planner gave there already
 * are not taken twice; a number or the record on screen is dropped. */
function createTarget(target: NonNullable<WriteIntent['target']>, wf: WorkflowModule, fields: ReadonlyMap<string, GroundField>,
  facts: MessageFacts, out: WriteGrounding): void {
  if (!('text' in target)) {
    out.dropped.push('number' in target ? { path: 'target.number', value: target.number } : { path: 'target.focus', value: '' });
    return;
  }
  const { text } = target;
  const words = matchableText(text);
  const drop = (): void => { out.dropped.push({ path: 'target.text', value: text }); };
  if (!words || !textFound(text, facts, 'run_on')) return drop();
  const { forRef, primaryText, nameSplit } = wf.cap;
  const forField = forRef ? fields.get(forRef) : undefined;
  // The record "for" names, while no reference names it yet.
  const nameFor = (): boolean => {
    const named = forRef && forField?.fill === 'ref' && !hasOwn(out.refs, forRef) ? namedRef(forField, text, facts) : null;
    if (named) out.refs[forRef!] = named;
    return !!named;
  };
  // The same words already naming the "for" record.
  const sameAsFor = (): boolean => {
    const given = forRef ? out.refs[forRef] : undefined;
    return !!given && !Array.isArray(given) && 'text' in given && matchableText(given.text) === words;
  };
  if (forRef && forField?.fill === 'ref' && facts.words.includes(` for ${words}`)) return sameAsFor() || nameFor() ? undefined : drop();
  // No primary text to fill (an invoice, Increment 7): the words name the "for" record, or are dropped.
  if (!nameSplit && primaryText === undefined) return sameAsFor() || nameFor() ? undefined : drop();
  const primary = nameSplit ? [nameSplit.first, nameSplit.last] : [primaryText!];
  const given = primary.filter((key) => hasOwn(out.values, key)).map((key) => String(out.values[key]));
  if (given.length) return matchableText(given.join(' ')) === words || nameFor() ? undefined : drop();
  if (fields.get(primary[0])?.fill !== 'value') return nameFor() ? undefined : drop();
  if (!nameSplit) {
    out.values[primaryText!] = text.trim();
    return;
  }
  const [first, ...rest] = text.trim().split(/\s+/);
  out.values[nameSplit.first] = first;
  if (rest.length && fields.get(nameSplit.last)?.fill === 'value') out.values[nameSplit.last] = rest.join(' ');
}

/** The planner's write intent for a module's guided form (`wf`) grounded in
 * the message (see above). `ctx`, the grammar context, reads its dates and
 * stage names; without it the dates are dropped. `refused` is set when the
 * intent can't run as written (an id, a "from" other than a source record's
 * number the message writes, an update's or delete's record not in the
 * message): `intent` is then the input, unchanged. fieldNotes: how the dates
 * were read (L14), for startWorkflow. */
export function groundWriteIntent(input: { intent: WriteIntent; message: string; wf: WorkflowModule; ctx?: GrammarContext }):
  { intent: WriteIntent; dropped: GroundingDrop[]; refused?: { path: string; value: string }; fieldNotes: Record<string, FieldNote> } {
  const { intent, message, wf, ctx } = input;
  const facts = factsOf(message);
  const from = groundedFrom(intent, wf, facts);
  const refused = writeRefusalOf(intent, from, facts);
  if (refused) return { intent: { ...intent }, dropped: [], refused, fieldNotes: {} };
  const fields = intentFields(wf, intent.op, ctx);
  const out: WriteGrounding = { values: {}, refs: {}, fieldNotes: {}, dropped: [] };
  groundFields(fields, intent.values, intent.refs, message, ctx, facts, out);
  if (intent.op === 'create' && intent.target) createTarget(intent.target, wf, fields, facts, out);
  (intent.lines ?? []).forEach((line, i) => out.dropped.push({ path: `lines.${i}`, value: line.text }));
  const target = intent.op === 'create' ? undefined : targetOf(intent);
  return {
    intent: {
      v: intent.v, op: intent.op, module: intent.module,
      ...(target ? { target } : {}),
      ...(from ? { from } : {}),
      ...(Object.keys(out.refs).length ? { refs: out.refs } : {}),
      ...(Object.keys(out.values).length ? { values: out.values } : {}),
    },
    dropped: out.dropped,
    fieldNotes: out.fieldNotes,
  };
}

/** The planner's answer to the guided form open in the chat (`spec`,
 * formSpecFor) grounded in the message (see above): the values and refs to
 * apply (applyFill), what was dropped, and how the dates were read (L14). */
export function groundFill(input: { values: Record<string, WriteValue>; refs: Record<string, { text: string }>; message: string; spec: FillFormSpec; ctx: GrammarContext }):
  { values: Record<string, WriteValue>; refs: Record<string, RefInput>; dropped: GroundingDrop[]; fieldNotes: Record<string, FieldNote> } {
  const out: WriteGrounding = { values: {}, refs: {}, fieldNotes: {}, dropped: [] };
  groundFields(fillFields(input.spec, input.ctx), input.values, input.refs, input.message, input.ctx, factsOf(input.message), out);
  // A fill names one record per field.
  const refs: Record<string, RefInput> = {};
  for (const [key, ref] of Object.entries(out.refs)) if (!Array.isArray(ref)) refs[key] = ref;
  return { values: out.values, refs, dropped: out.dropped, fieldNotes: out.fieldNotes };
}
