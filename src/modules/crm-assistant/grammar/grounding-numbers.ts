import { CURRENCY_MARKERS, GLUED_MULTIPLIERS, MAX_AMOUNT, MULTIPLIERS, roundAmount, toAsciiDigits } from './numbers';
import { WordToken, tokenizeV1 } from './tokens';
import { NUMBER_WORDS } from './vocabulary';

/* Numbers as planner grounding reads a message (planner-grounding.ts):
 * more widely than grammar v1 reads them, so a number the planner took from
 * the message is found however the message writes it.
 *
 *   - The multiplier words of the Indian languages an assistant can be set
 *     to, besides the English ones ("५ लाख", "5 லட்சத்துக்கு", "2 கோடி"),
 *     and "hundred".
 *   - Number words beyond grammar v1's ("fifty thousand", "twenty five",
 *     "a dozen", "one and a half lakh", "half a lakh").
 *   - One multiplier shared by a range or a list ("between 10 and 20 lakh",
 *     "10-20 lakh", "5 or 10 lakh"; grammar/parse.ts moneyRangeAt reads a
 *     range the same way) and an amount written in parts ("1 lakh 50
 *     thousand", "5 thousand 500").
 *   - "1500,2000" as two numbers, "5000 -10000" as a range rather than a
 *     negative number, and the Arabic decimal separator ("١٫٥" is 1.5).
 *   - On money fields only, "10L" and "1.5 L" as lakhs and "5m" and "1.2 M"
 *     as millions; on any other field "30m" is 30.
 *   - The time unit written right after a number ("90 minutes", "2 घंटे"),
 *     so a duration field can have it in its own unit.
 *
 * The digits of a d/m/y date or of a phone number written in groups are not
 * numbers here. A number written only as the base of a larger amount ("5"
 * of "5 lakh", "90" of "90 minutes" on a field kept in hours) is kept apart
 * from the numbers written on their own, together with that amount.
 *
 * Grammar v1 never reads through this file: its numbers (numbers.ts) and
 * words (vocabulary.ts) stay English-only and as they are (D17). Pure. */

/** Numbers a condition on one kind of field may use. */
export interface NumberFacts {
  /** The numbers the message writes on their own, and whole amounts ("5 lakh" is 500000). */
  plain: readonly number[];
  /** A number written only as the base of a larger amount, with that amount
   * ("5" of "5 lakh": 500000; "90" of "90 minutes" on a field in hours: 1.5). */
  bases: ReadonlyArray<{ base: number; value: number }>;
}

/** The units a duration field is kept in (registry/types.ts FieldCap.unit). */
export type DurationUnit = 'seconds' | 'minutes' | 'hours';

export interface MessageNumbers {
  /** For money fields. */
  money: NumberFacts;
  /** For any other number field: only multiplier words count ("5k", "2 lakh"). */
  other: NumberFacts;
  /** For a duration field kept in `unit`: a number with a time unit after it counts in `unit`. */
  durationIn(unit: DurationUnit): NumberFacts;
  /** Each amount written with a currency next to it ("$5000", "5 lakh rupees"), with its ISO code. */
  currencies: ReadonlyArray<{ value: number; currency: string }>;
}

type Words = ReadonlyArray<WordToken | undefined>;
type TimeUnit = DurationUnit | 'days';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Zero-width characters a keyboard may put inside a word (joiners in Indic scripts). */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/** U+066B, the Arabic decimal separator. */
const ARABIC_DECIMAL = /\u066B/g;
/** A d/m/y or y/m/d date ("15/10/2025", "15-10-25", "2026.10.15"). */
const DATE_RUN = /(?<!\d)(?:\d{1,2}([./-])\d{1,2}\1\d{2,4}|\d{4}([./-])\d{1,2}\2\d{1,2})(?!\d)/g;
/** Digit groups with spaces, dots, dashes or brackets between them, never
 * part of a word or an id: the shape of a phone number (isPhone), as the AI
 * service's placeholders.ts masks it. */
const PHONE_RUN = /(?<![\p{L}\p{M}\p{N}_+(]|[\p{L}\p{M}\p{N}][-./])[+(]?\d+(?:[ ().-]{1,3}\d+)+(?![\p{L}\p{M}\p{N}_]|[-./:][\p{L}\p{M}\p{N}])/gu;
/** A number and the word right after it, glued or not ("५ लाख", "५लाख", "90 मिनट"). */
const NUMBER_THEN_WORD = /(\d+(?:[.,]\d+)*)(\s*)([\p{L}\p{M}]+)/gu;
/** A comma group that isn't one number ("1500,2000": parseNumeral refused it, so tokenizeV1 left it a word). */
const COMMA_GROUP = /^\d+(?:,\d+)+$/;

/** Multiplier, time and range words of the Indian languages an assistant
 * can be set to, each read as the English word for it when it comes right
 * after a number. A stem matches every word that starts with it, so case
 * endings are read too ("லட்சத்துக்கு", "লাখের"); a whole word matches only
 * itself: Hindi सौ, since सौदा and सौदे are "deal" and "deals". Tamil
 * லட்சம் and லட்சத் are stems, not bare லட்ச, which also starts லட்சியம்
 * ("goal"). */
const NATIVE_WORDS: ReadonlyArray<{ form: string; whole: boolean; as: string }> = ([
  // Hindi and Marathi
  ['hundred', true, 'सौ'], ['thousand', false, 'हज़ार', 'हजार'], ['lakh', false, 'लाख'],
  ['crore', false, 'करोड', 'कोटी'], ['billion', false, 'अरब'],
  // Bengali, Gujarati, Punjabi
  ['thousand', false, 'হাজার', 'હજાર', 'ਹਜ਼ਾਰ', 'ਹਜਾਰ'], ['lakh', false, 'লাখ', 'লক্ষ', 'લાખ', 'ਲੱਖ'],
  ['crore', false, 'কোটি', 'કરોડ', 'ਕਰੋੜ'],
  // Tamil
  ['hundred', false, 'நூறு', 'நூற்ற'], ['thousand', false, 'ஆயிர'], ['lakh', false, 'லட்சம்', 'லட்சத்', 'இலட்சம்', 'இலட்சத்'],
  ['crore', false, 'கோடி'],
  // Telugu, Kannada, Malayalam
  ['thousand', false, 'వేల', 'ಸಾವಿರ', 'ആയിര'], ['lakh', false, 'లక్ష', 'ಲಕ್ಷ', 'ലക്ഷ'],
  ['crore', false, 'కోటి', 'కోట్ల', 'ಕೋಟಿ', 'കോടി'],
  // Urdu
  ['thousand', false, 'ہزار'], ['lakh', false, 'لاکھ'], ['crore', false, 'کروڑ'],
  // Time units (Hindi, Tamil)
  ['seconds', false, 'सेकंड', 'सेकेंड', 'நொடி'], ['minutes', false, 'मिनट', 'நிமிட'],
  ['hours', false, 'घंटा', 'घंटे', 'घंटों', 'மணி'],
  // Ranges and lists (Hindi, Tamil): "10 से 20 लाख", "5 या 10 लाख", "10 முதல் 20 லட்சம்"
  ['to', true, 'से', 'முதல்'], ['or', true, 'या', 'அல்லது'],
] as Array<[string, boolean, ...string[]]>).flatMap(([as, whole, ...forms]) => forms.map((form) => ({ form: form.normalize('NFKC'), whole, as })));

/** Number words besides grammar v1's (vocabulary.ts NUMBER_WORDS: one to ten, fifteen, twenty, thirty). */
const MORE_NUMBER_WORDS: Readonly<Record<string, number>> = {
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12, hundred: 100,
};
/** Tens that take a unit after them ("twenty five", "twenty-five"). */
const TENS: ReadonlySet<string> = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);
const HUNDRED = 100;
/** Words that join the numbers of one range or list ("10 to 20 lakh", "5 or 10 lakh", "10 se 20 lakh"). */
const JOINERS: ReadonlySet<string> = new Set(['and', 'to', 'or', 'till', 'until', 'se']);
/** Time words after a number ("90 minutes", "2hrs", "1.5 h"); not "m", which is millions on money. */
const TIME_UNITS: Readonly<Record<string, TimeUnit>> = {
  s: 'seconds', sec: 'seconds', secs: 'seconds', second: 'seconds', seconds: 'seconds',
  min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes',
  h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
  day: 'days', days: 'days',
};
const SECONDS_IN: Readonly<Record<TimeUnit, number>> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** A run of PHONE_RUN's shape is a phone number when it has 10 to 15
 * digits, unless it is an amount: a decimal ("1234567890.50") or a rising
 * pair of round amounts ("50000-100000", "100000 200000"). */
function isPhone(run: string): boolean {
  const digits = run.replace(/\D/g, '').length;
  if (digits < 10 || digits > 15) return false;
  if (/^[+(]/.test(run)) return true;
  if (/^\d+\.\d{1,2}$/.test(run)) return false;
  const groups = run.split(/\D+/);
  const roundPair = groups.length === 2 && groups.every((g) => /^[1-9]\d{3,6}$/.test(g) && g.endsWith('00'))
    && Number(groups[0]) < Number(groups[1]);
  return !roundPair;
}

/** The English word a native multiplier or time word is read as. */
function nativeWordAs(word: string): string | undefined {
  return NATIVE_WORDS.find((n) => (n.whole ? word === n.form : word.startsWith(n.form)))?.as;
}

/** The message as its numbers are read: NFKC, digits of any script as
 * ASCII, no zero-width characters, the Arabic decimal separator as ".",
 * dates and phone numbers taken out, and native multiplier and time words
 * after a number as their English words (tokenizeV1's words are letters and
 * digits only, so it splits "लाख" at its vowel sign). */
function numberText(message: string): string {
  return toAsciiDigits(message.normalize('NFKC'))
    .replace(ZERO_WIDTH, '')
    .replace(ARABIC_DECIMAL, '.')
    .replace(DATE_RUN, ' date ')
    .replace(PHONE_RUN, (run) => (isPhone(run) ? ' phone ' : run))
    .replace(NUMBER_THEN_WORD, (whole: string, number: string, space: string, word: string) => {
      const as = nativeWordAs(word);
      return as ? `${number}${space}${as}` : whole;
    });
}

function numberWord(w: string | undefined): number | undefined {
  if (w === undefined) return undefined;
  if (hasOwn(NUMBER_WORDS, w)) return NUMBER_WORDS[w];
  return hasOwn(MORE_NUMBER_WORDS, w) ? MORE_NUMBER_WORDS[w] : undefined;
}

/** A multiplier word: grammar v1's (numbers.ts MULTIPLIERS: k, thousand, lakh, crore, million, billion and their forms) or "hundred". */
function wordMultiplierOf(t: WordToken | undefined): number | undefined {
  if (!t) return undefined;
  if (hasOwn(MULTIPLIERS, t.w)) return MULTIPLIERS[t.w];
  return t.w === 'hundred' ? HUNDRED : undefined;
}

/** On a money field the letters l and m multiply too, glued ("10L", "5m") or not ("1.5 L", "1.2 M"). */
function multiplierOf(t: WordToken | undefined, money: boolean): number | undefined {
  const word = wordMultiplierOf(t);
  if (word !== undefined || !money || !t) return word;
  return hasOwn(GLUED_MULTIPLIERS, t.w) ? GLUED_MULTIPLIERS[t.w] : undefined;
}

function currencyOf(t: WordToken | undefined): string | undefined {
  return t && hasOwn(CURRENCY_MARKERS, t.w) ? CURRENCY_MARKERS[t.w] : undefined;
}

function timeUnitOf(t: WordToken | undefined): TimeUnit | undefined {
  return t && hasOwn(TIME_UNITS, t.w) ? TIME_UNITS[t.w] : undefined;
}

/** "and a half" or "and half" at words[k]: how many words it takes (0 when it isn't there). */
function andAHalfAt(words: Words, k: number): number {
  if (words[k]?.w !== 'and') return 0;
  if (words[k + 1]?.w === 'half') return 2;
  return words[k + 1]?.w === 'a' && words[k + 2]?.w === 'half' ? 3 : 0;
}

/** A number written at words[j]: digits ("-500"; in "5000 -10000" the dash
 * joins a range, it is no minus), a number word ("twelve", "twenty five"),
 * "a", "half" or "quarter" before a multiplier word ("a lakh", "half a
 * lakh"), each with "and a half" after it if written ("one and a half"). */
function numeralAt(words: Words, j: number): { value: number; len: number } | null {
  const t = words[j];
  if (!t) return null;
  let value: number;
  let len = 1;
  if (t.num !== undefined) {
    value = t.neg && words[j - 1]?.num === undefined ? -t.num : t.num;
  } else if (t.w === 'a' || t.w === 'an' || t.w === 'half' || t.w === 'quarter') {
    const article = words[j + 1]?.w === 'a' || words[j + 1]?.w === 'an';
    const k = (t.w === 'half' || t.w === 'quarter') && article ? j + 2 : j + 1;
    if (wordMultiplierOf(words[k]) === undefined) return null;
    return { value: t.w === 'half' ? 0.5 : t.w === 'quarter' ? 0.25 : 1, len: k - j };
  } else {
    const word = numberWord(t.w);
    if (word === undefined) return null;
    const unit = TENS.has(t.w) ? numberWord(words[j + 1]?.w) : undefined;
    if (unit !== undefined && unit < 10) {
      value = word + unit;
      len = 2;
    } else {
      value = word;
    }
  }
  const half = value >= 0 ? andAHalfAt(words, j + len) : 0;
  return { value: half ? value + 0.5 : value, len: len + half };
}

/** One number as the message writes it, tokens [start, end). */
interface Written {
  start: number;
  end: number;
  /** The number before any multiplier. */
  base: number;
  multiplier?: number;
  /** base × multiplier, or the base. */
  value: number;
  currency?: string;
  /** The time unit written right after a number with no multiplier. */
  unit?: TimeUnit;
}

/** The number written at words[i]: [currency] number [multiplier]
 * [currency], as numbers.ts matchMoney reads an amount, more widely (see
 * above). A negative number takes no multiplier, nor does one that would
 * make an amount past MAX_AMOUNT. */
function writtenAt(words: Words, i: number, money: boolean): Written | null {
  let j = i;
  let currency = currencyOf(words[j]);
  if (currency) j += 1;
  const numeral = numeralAt(words, j);
  if (!numeral) return null;
  j += numeral.len;
  let multiplier: number | undefined;
  const first = numeral.value >= 0 ? multiplierOf(words[j], money) : undefined;
  if (first !== undefined) {
    // "five hundred thousand", "5 hundred crore".
    const more = first === HUNDRED ? wordMultiplierOf(words[j + 1]) : undefined;
    const len = more !== undefined && more > HUNDRED ? 2 : 1;
    const by = len === 2 ? first * (more as number) : first;
    if (numeral.value * by <= MAX_AMOUNT) {
      multiplier = by;
      j += len;
    }
  }
  const after = currencyOf(words[j]);
  if (after && (!currency || currency === after)) {
    currency = after;
    j += 1;
  }
  const unit = multiplier === undefined ? timeUnitOf(words[j]) : undefined;
  return {
    start: i, end: j, base: numeral.value,
    value: multiplier === undefined ? numeral.value : roundAmount(numeral.value * multiplier),
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
  };
}

interface Scan {
  spans: Written[];
  /** The numbers of comma groups that aren't one number ("1500,2000"). */
  parts: number[];
}

/** Every number the message writes, left to right. */
function scan(words: Words, money: boolean): Scan {
  const spans: Written[] = [];
  const parts: number[] = [];
  for (let i = 0; i < words.length;) {
    const span = writtenAt(words, i, money);
    if (span) {
      spans.push(span);
      i = span.end;
      continue;
    }
    const t = words[i];
    if (t && t.num === undefined && COMMA_GROUP.test(t.w)) parts.push(...t.w.split(',').map(Number));
    i += 1;
  }
  return { spans, parts };
}

/** b comes right after a ("10-20 lakh": the dash is no token) or after one joining word. */
function joined(words: Words, a: Written, b: Written): boolean {
  if (a.end === b.start) return true;
  const between = words[a.end];
  return a.end + 1 === b.start && !!between && JOINERS.has(between.w);
}

/** A number with no multiplier right before one with a multiplier
 * (directly or after one joining word) shares the multiplier when that
 * keeps it no larger: "between 10 and 20 lakh" holds 1000000, as
 * grammar/parse.ts moneyRangeAt reads a range, and "5, 10 or 20 lakh" holds
 * 500000. Per number: the amount it then makes, and the currency written
 * with either. */
function sharedMultipliers(words: Words, spans: readonly Written[]): Array<{ value: number; currency?: string } | undefined> {
  const shared: Array<{ value: number; multiplier: number; currency?: string } | undefined> = spans.map(() => undefined);
  for (let k = spans.length - 1; k > 0; k -= 1) {
    const a = spans[k - 1];
    const b = spans[k];
    const next = shared[k] ?? (b.multiplier !== undefined ? { value: b.value, multiplier: b.multiplier, currency: b.currency } : undefined);
    if (!next || a.multiplier !== undefined || a.unit || a.base < 0 || !joined(words, a, b)) continue;
    const value = roundAmount(a.base * next.multiplier);
    if (value > next.value) continue;
    const currency = a.currency ?? next.currency;
    shared[k - 1] = { value, multiplier: next.multiplier, ...(currency ? { currency } : {}) };
  }
  return shared;
}

/** The time unit of each number: its own, or the one of the number after it
 * in a range or a list ("between 30 and 90 minutes", "2-3 hours"). */
function timeUnits(words: Words, spans: readonly Written[]): Array<TimeUnit | undefined> {
  const units = spans.map((s) => s.unit);
  for (let k = spans.length - 1; k > 0; k -= 1) {
    const a = spans[k - 1];
    const unit = units[k];
    if (unit && !units[k - 1] && a.multiplier === undefined && a.value <= spans[k].value && joined(words, a, spans[k])) units[k - 1] = unit;
  }
  return units;
}

/** An amount written in parts, each smaller than the multiplier before it:
 * "1 lakh 50 thousand" (150000), "2 crore 50 lakh", "5 thousand 500". */
function sums(spans: readonly Written[]): Array<{ value: number; currency?: string }> {
  const out: Array<{ value: number; currency?: string }> = [];
  for (let k = 0; k < spans.length; k += 1) {
    let last = spans[k].multiplier;
    if (last === undefined) continue;
    let total = spans[k].value;
    let currency = spans[k].currency;
    let n = k + 1;
    while (n < spans.length && last !== undefined && spans[n - 1].end === spans[n].start) {
      const part = spans[n];
      if (part.value < 0 || part.unit || (part.multiplier ?? part.value) >= last) break;
      total += part.value;
      currency = currency ?? part.currency;
      last = part.multiplier;
      n += 1;
    }
    if (n > k + 1) {
      out.push({ value: roundAmount(total), ...(currency ? { currency } : {}) });
      k = n - 1;
    }
  }
  return out;
}

/** What one reading of the message offers a condition. With `unit` (a
 * duration field's), a number with a time unit counts in that unit: "90
 * minutes" is 1.5 on a field kept in hours, its 90 only the base of the
 * 1.5; a number with no time unit counts as written. */
function factsFrom(words: Words, read: Scan, unit?: DurationUnit): NumberFacts {
  const plain: number[] = [...read.parts];
  const bases: Array<{ base: number; value: number }> = [];
  const shared = sharedMultipliers(words, read.spans);
  const units = unit ? timeUnits(words, read.spans) : [];
  read.spans.forEach((s, k) => {
    const written = units[k];
    if (unit && written) {
      const exact = (s.value * SECONDS_IN[written]) / SECONDS_IN[unit];
      const value = roundAmount(exact);
      plain.push(exact, value);
      if (written !== unit) bases.push({ base: s.value, value });
      return;
    }
    const carried = shared[k];
    if (carried) {
      plain.push(carried.value);
      bases.push({ base: s.base, value: carried.value });
      return;
    }
    plain.push(s.value);
    if (s.multiplier !== undefined) bases.push({ base: s.base, value: s.value });
  });
  for (const sum of sums(read.spans)) plain.push(sum.value);
  return { plain, bases };
}

function currenciesOf(words: Words, read: Scan): Array<{ value: number; currency: string }> {
  const shared = sharedMultipliers(words, read.spans);
  const out: Array<{ value: number; currency: string }> = [];
  read.spans.forEach((s, k) => {
    const carried = shared[k];
    const currency = carried?.currency ?? s.currency;
    if (currency) out.push({ value: carried?.value ?? s.value, currency });
  });
  for (const sum of sums(read.spans)) if (sum.currency) out.push({ value: sum.value, currency: sum.currency });
  return out;
}

/** The numbers of `message` as grounding reads them (see above). */
export function readNumbers(message: string): MessageNumbers {
  const words: Words = tokenizeV1(numberText(message)).map((t) => (t.kind === 'word' ? t : undefined));
  const money = scan(words, true);
  const other = scan(words, false);
  const durations = new Map<DurationUnit, NumberFacts>();
  return {
    money: factsFrom(words, money),
    other: factsFrom(words, other),
    durationIn(unit: DurationUnit): NumberFacts {
      let facts = durations.get(unit);
      if (!facts) durations.set(unit, (facts = factsFrom(words, other, unit)));
      return facts;
    },
    currencies: currenciesOf(words, money),
  };
}
