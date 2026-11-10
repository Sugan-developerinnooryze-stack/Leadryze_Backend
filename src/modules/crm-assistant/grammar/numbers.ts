import type { WordToken } from './tokens';
import { NUMBER_WORDS } from './vocabulary';

/* Numbers for grammar v1 (Increment 3): digits of any script, Western and
 * Indian digit grouping, decimals, multipliers (k, thousand, lakh, crore,
 * million) and currency markers. Pure: no database, no clock. */

const DECIMAL_DIGIT = /\p{Nd}/u;

/** The ASCII digit for one Unicode decimal digit (Devanagari ३, Tamil ௩,
 * Arabic-Indic ٣, fullwidth ３ ...). Unicode encodes every decimal digit set
 * as a run of ten code points from 0 to 9, and adjacent runs are whole sets,
 * so the value is the distance from the start of the run, modulo 10. */
export function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return ch;
  if (cp >= 0x30 && cp <= 0x39) return ch;
  if (!DECIMAL_DIGIT.test(ch)) return ch;
  let start = cp;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((cp - start) % 10);
}

/** Every decimal digit of any script, as ASCII ("₹१,००,०००" -> "₹1,00,000"). */
export function toAsciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, asciiDigit);
}

const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+$/;
const INDIAN_GROUPS = /^\d{1,2}(,\d{2})*,\d{3}$/;

/** A written number: "100000", "1,00,000" (Indian grouping), "100,000"
 * (Western), "2.5", ".5", "50,000.75", in any script's digits. Null for
 * anything else, including commas that group nothing ("1,2", "1,0000"). */
export function parseNumeral(raw: string): number | null {
  const m = /^(?:(\d+(?:,\d+)*)(?:\.(\d+))?|\.(\d+))$/.exec(toAsciiDigits(raw.trim()));
  if (!m) return null;
  const whole = m[1] ?? '0';
  const fraction = m[2] ?? m[3];
  if (whole.includes(',') && !WESTERN_GROUPS.test(whole) && !INDIAN_GROUPS.test(whole)) return null;
  const value = Number(whole.replace(/,/g, '') + (fraction ? `.${fraction}` : ''));
  return Number.isFinite(value) ? value : null;
}

/** Words that multiply the number before them ("1 lakh", "2.5 crore", "50 k"). */
export const MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  k: 1e3, thousand: 1e3, thousands: 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7,
  million: 1e6, millions: 1e6, mn: 1e6,
  billion: 1e9, billions: 1e9, bn: 1e9,
});

/** Single letters that multiply only when written against the number
 * ("10L", "5m"); "10 l" or "5 m" on their own are not amounts. */
export const GLUED_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({ l: 1e5, m: 1e6 });

/** Currency markers before or after an amount, as ISO codes. */
export const CURRENCY_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  '₹': 'INR', rs: 'INR', inr: 'INR', rupee: 'INR', rupees: 'INR',
  '$': 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD',
});

/** Larger amounts are not believable; the parse is refused. */
export const MAX_AMOUNT = 1e15;

/** The Field Service currency when a tenant sets none (FSSettings.currency
 * default, which getSettings also falls back to). Field Service amounts carry
 * no currency of their own: they are in the caller's (GrammarContext.fsCurrency,
 * context.ts), and a currency written next to one is believed only when it is
 * that one; any other goes to the existing assistant rather than being
 * compared as if it were the caller's (grammar v1). */
export const FS_DEFAULT_CURRENCY = 'INR';

export interface MoneyMatch {
  value: number;
  /** Tokens used. */
  length: number;
  /** ISO code of a currency marker written next to the number. */
  currency?: string;
  /** The multiplier word or letter, when there was one. */
  multiplier?: number;
  /** The number as written, before any multiplier. */
  base: number;
}

const multiplierOf = (t: WordToken | undefined): number | undefined => {
  if (!t) return undefined;
  if (Object.prototype.hasOwnProperty.call(MULTIPLIERS, t.w)) return MULTIPLIERS[t.w];
  return t.glued && Object.prototype.hasOwnProperty.call(GLUED_MULTIPLIERS, t.w) ? GLUED_MULTIPLIERS[t.w] : undefined;
};

const currencyOf = (t: WordToken | undefined): string | undefined =>
  t && Object.prototype.hasOwnProperty.call(CURRENCY_MARKERS, t.w) ? CURRENCY_MARKERS[t.w] : undefined;

/** Rounds away binary noise (2.3 * 1e5 = 229999.99999999997). */
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A number written as a word counts only before a multiplier ("a lakh",
 * "two crore", "ten thousand"), never on its own. */
function wordNumber(t: WordToken | undefined, next: WordToken | undefined): number | undefined {
  if (!t || multiplierOf(next) === undefined) return undefined;
  if (t.w === 'a' || t.w === 'an') return 1;
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t.w) ? NUMBER_WORDS[t.w] : undefined;
}

/** An amount at tokens[i]: [currency] number [multiplier] [currency]
 * ("₹1,00,000", "Rs. 50,000", "INR 2 lakh", "50k", "2.5 crore rupees",
 * "$5,000", "a lakh"). Two different currencies, a negative or an
 * unbelievable value give null. */
export function matchMoney(tokens: ReadonlyArray<WordToken | undefined>, i: number): MoneyMatch | null {
  let j = i;
  let currency = currencyOf(tokens[j]);
  if (currency) j += 1;
  const n = tokens[j];
  if (n?.neg) return null;
  const base = n?.num ?? wordNumber(n, tokens[j + 1]);
  if (base === undefined) return null;
  j += 1;
  const multiplier = multiplierOf(tokens[j]);
  if (multiplier !== undefined) j += 1;
  const after = currencyOf(tokens[j]);
  if (after) {
    if (currency && currency !== after) return null;
    currency = after;
    j += 1;
  }
  const value = roundAmount(base * (multiplier ?? 1));
  if (!Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) return null;
  return {
    value, length: j - i, base,
    ...(currency ? { currency } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
  };
}
