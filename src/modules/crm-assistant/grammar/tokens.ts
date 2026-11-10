import { parseNumeral, toAsciiDigits } from './numbers';

/* Grammar v0 vocabulary and tokenizer. Words are matched whole and
 * lower-cased, never as substrings: "address" is not "add", "marketing" is
 * not "mark", "changed" is not "change". Grammar v1's tokenizer
 * (tokenizeV1) also keeps numbers, ISO dates and currency symbols whole. */

/** A business number as the models generate it: the tenant's client prefix
 * (Tenant.clientId, 8 hex characters, or the last 6 characters of the tenant
 * id; seeded tenants use letters and digits), the module code, and a
 * sequence of at least four digits (`${pfx}-WO-${String(n).padStart(4, '0')}`
 * in workorder.model.ts and its siblings). */
export const BUSINESS_NUMBER_RE = /(?<![\p{L}\p{N}_-])([A-Za-z0-9]{4,12})-([A-Za-z]{2,4})-(\d{4,9})(?![\p{L}\p{N}_-])/gu;

/** The whole of a value is one business number (ASCII digits: convert other
 * scripts' digits first); group 2 is the module code. Not global, so .test()
 * and .exec() keep no state between calls (BUSINESS_NUMBER_RE's lastIndex would). */
export const BUSINESS_NUMBER_EXACT = /^([A-Za-z0-9]{4,12})-([A-Za-z]{2,4})-(\d{4,9})$/u;

/** Module code -> registry module key, read from each model's id generator.
 * Quotations, contracts and receipts are registry modules since Increment 5,
 * so their numbers open the record as the others do. */
export const BUSINESS_NUMBER_MODULES: Readonly<Record<string, string>> = {
  WO: 'workorder',      // workorder.model.ts  workOrderId
  INV: 'invoice',       // invoice.model.ts    invoiceId
  CUS: 'customer',      // customer.model.ts   customerId
  LEAD: 'lead',         // lead.model.ts       leadId
  CAT: 'category',      // category.model.ts   categoryId
  SV: 'service',        // service.model.ts    serviceId
  PT: 'part',           // part.model.ts       partId
  PRD: 'product',       // product.model.ts    productId
  AST: 'asset',         // asset.model.ts      assetId
  VEH: 'vehicle',       // vehicle.model.ts    vehicleId
  EXP: 'expense',       // expense.model.ts    expenseId
  SITE: 'site',         // site.model.ts       siteId
  ST: 'staff',          // staff.model.ts      staffId
  TM: 'team',           // team.model.ts       teamId
  ACT: 'activity',      // activity.model.ts   activityId
  TKT: 'ticket',        // ticket.schema.ts    ticketNumber / ticketId
  QUO: 'quotation',     // quotation.model.ts  quotationId
  CON: 'contract',      // contract.model.ts   contractId
  RCP: 'receipt',       // receipt.model.ts    receiptId
};

export type Token =
  | {
      kind: 'word';
      w: string;
      /** tokenizeV1 only: the value of a written number ("1,00,000" -> 100000; w is then "100000"). */
      num?: number;
      /** tokenizeV1 only: letters written against the number before them ("5k", "1st", "10L"). */
      glued?: boolean;
      /** tokenizeV1 only: a YYYY-MM-DD date as written. */
      iso?: string;
      /** tokenizeV1 only: a minus sign was written before the number ("-5000"). */
      neg?: boolean;
    }
  | { kind: 'number'; number: string; code: string };
export type WordToken = Extract<Token, { kind: 'word' }>;

/** Lower-cases and splits into words (letters and digits of any script);
 * apostrophes are dropped ("what's" -> "whats"), everything else separates
 * words. Business numbers are taken out first, upper-cased, as their own
 * tokens. */
export function tokenize(message: string): Token[] {
  const text = message.normalize('NFKC');
  const tokens: Token[] = [];
  let last = 0;
  const pushWords = (segment: string) => {
    const cleaned = segment.toLowerCase().replace(/['’‘`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (cleaned) for (const w of cleaned.split(/\s+/)) tokens.push({ kind: 'word', w });
  };
  for (const m of text.matchAll(BUSINESS_NUMBER_RE)) {
    pushWords(text.slice(last, m.index));
    tokens.push({ kind: 'number', number: m[0].toUpperCase(), code: m[2].toUpperCase() });
    last = (m.index ?? 0) + m[0].length;
  }
  pushWords(text.slice(last));
  return tokens;
}

/** Splits a phrase (a registry synonym, say) into words the same way. */
export function phraseWords(phrase: string): string[] {
  return tokenize(phrase).flatMap((t) => (t.kind === 'word' ? [t.w] : []));
}

/* One v1 lexeme: an ISO date; a number (digit groups, decimals, or a decimal
 * with no digit before its point, ".5", where the point follows no digit,
 * point or currency word: "over.5" is 0.5, "Rs.5" is 5) with any letters
 * written against it; a currency symbol (any, so "€" is a word the grammar
 * doesn't know rather than nothing); or a word. The currency words are the
 * letter keys of numbers.ts CURRENCY_MARKERS (rs, inr, rupee(s), usd,
 * dollar(s)); tests/crm-assist-grammar.test.ts checks every one of them. */
const V1_LEXEME = /(\d{4}-\d{2}-\d{2})(?![\p{L}\p{N}])|(\d+(?:,\d+)*(?:\.\d+)?|(?<![\p{N}.])(?<!(?<![\p{L}\p{N}])(?:rs|inr|rupees?|usd|dollars?))\.\d+)(\p{L}+)?|(\p{Sc})|([\p{L}\p{N}]+)/gu;

/** A minus sign right before a number, not between two numbers ("-5000",
 * "over −5000"; "1-2" is not negative). */
function isNegativeAt(text: string, index: number): boolean {
  const sign = text[index - 1];
  if (sign !== '-' && sign !== '−') return false;
  return index < 2 || !/[\p{L}\p{N}]/u.test(text[index - 2]);
}

/** A token's place in the message: [start, end) in V1Tokens.text. */
export type TokenSpan = readonly [start: number, end: number];

/** tokenizeV1's tokens and where each one was written (Increment 5): `text`
 * is the message as the tokens read it (NFKC, digits of any script as ASCII)
 * and spans[i] is tokens[i]'s [start, end) in it, so a name is taken as it
 * was written ("invoices for Kumar & Sons": "Kumar & Sons", with its capitals
 * and punctuation). A span is null where lower-casing changed the length of
 * the text, so no place is known. */
export interface V1Tokens { tokens: Token[]; spans: Array<TokenSpan | null>; text: string }

const APOSTROPHE = /['’‘`]/;

/** For each UTF-16 unit of `lowered` (the segment lower-cased with its
 * apostrophes dropped, as tokenizeV1 reads it): the [start, end) of the
 * character it came from in the segment. Null when lower-casing one character
 * at a time doesn't give the same length. */
function sourceUnits(segment: string, lowered: string): TokenSpan[] | null {
  const units: TokenSpan[] = [];
  for (let i = 0; i < segment.length;) {
    const ch = String.fromCodePoint(segment.codePointAt(i) as number);
    if (!APOSTROPHE.test(ch)) for (let k = 0; k < ch.toLowerCase().length; k += 1) units.push([i, i + ch.length]);
    i += ch.length;
  }
  return units.length === lowered.length ? units : null;
}

/** Grammar v1 tokens. Like tokenize(), plus: decimal digits of any script
 * are read as ASCII; a written number is one token with its value
 * ("1,00,000" -> w "100000", num 100000; "2.5"; ".5" -> 0.5; "١٥" -> 15); letters written
 * against a number become their own token marked glued ("5k" -> 5, k;
 * "1st" -> 1, st); a YYYY-MM-DD date stays whole; currency symbols (₹, $,
 * €, ...) are words; a minus sign marks the number neg. Commas that group
 * nothing ("1,2") leave the text as a plain word. */
export function tokenizeV1(message: string): Token[] {
  return tokenizeV1Spans(message).tokens;
}

/** tokenizeV1 with where each token was written (V1Tokens). */
export function tokenizeV1Spans(message: string): V1Tokens {
  const text = toAsciiDigits(message.normalize('NFKC'));
  const tokens: Token[] = [];
  const spans: Array<TokenSpan | null> = [];
  let last = 0;
  const lex = (segment: string, offset: number) => {
    const lower = segment.toLowerCase().replace(/['’‘`]/g, '');
    const units = sourceUnits(segment, lower);
    const push = (token: Token, from: number, to: number) => {
      tokens.push(token);
      spans.push(units ? [offset + units[from][0], offset + units[to - 1][1]] : null);
    };
    for (const m of lower.matchAll(V1_LEXEME)) {
      const at = m.index ?? 0;
      if (m[1]) { push({ kind: 'word', w: m[1], iso: m[1] }, at, at + m[1].length); continue; }
      if (m[2] !== undefined) {
        const value = parseNumeral(m[2]);
        const neg = isNegativeAt(lower, at) ? { neg: true } : {};
        push(value === null ? { kind: 'word', w: m[2], ...neg } : { kind: 'word', w: String(value), num: value, ...neg }, at, at + m[2].length);
        if (m[3]) push({ kind: 'word', w: m[3], glued: true }, at + m[2].length, at + m[0].length);
        continue;
      }
      push({ kind: 'word', w: m[4] ?? m[5] }, at, at + m[0].length);
    }
  };
  for (const m of text.matchAll(BUSINESS_NUMBER_RE)) {
    const at = m.index ?? 0;
    lex(text.slice(last, at), last);
    tokens.push({ kind: 'number', number: m[0].toUpperCase(), code: m[2].toUpperCase() });
    spans.push([at, at + m[0].length]);
    last = at + m[0].length;
  }
  lex(text.slice(last), last);
  return { tokens, spans, text };
}

/** Text written in double quotes ("..." or “...”): what is inside each pair,
 * as [start, end) in V1Tokens.text. A quote that is never closed quotes nothing. */
export function quotedSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const m of text.matchAll(/"([^"]*)"|“([^”]*)”/g)) {
    const start = (m.index ?? 0) + 1;
    spans.push([start, start + (m[1] ?? m[2] ?? '').length]);
  }
  return spans;
}

/** Splits a phrase (a stage label, an enum value) into v1 words. */
export function phraseWordsV1(phrase: string): string[] {
  return tokenizeV1(phrase).flatMap((t) => (t.kind === 'word' ? [t.w] : []));
}

const set = (...words: string[]): ReadonlySet<string> => new Set(words);

/** "show me customers", "list out leads", "give me the work orders". */
export const LIST_VERBS = set('show', 'list', 'find', 'display', 'view', 'see', 'get', 'give');
/** Single words that ask for a count ("count leads", "total customers"). */
export const COUNT_WORDS = set('count', 'total');
/** Multi-word count phrases. */
export const COUNT_PHRASES: readonly string[][] = [['how', 'many'], ['number', 'of']];

/** Words that never change what is asked. */
export const FILLERS = set(
  'me', 'all', 'the', 'please', 'pls', 'plz', 'kindly', 'can', 'could', 'would', 'will', 'you', 'u',
  'here', 'ok', 'okay', 'out', 'us', 'our', 'do', 'does', 'we', 'i', 'have', 'has', 'there', 'is', 'are',
  'a', 'an', 'of', 'in', 'any', 'what', 'whats', 'which', 'and', 'to', 'just', 'now', 'currently', 'want',
  'need', 'like', 'let', 'lets', 'know', 'tell', 'from', 'records', 'record', 'entries', 'entry', 'details',
  'detail', 'about', 'some', 'every', 'available', 'existing', 'so', 'far', 'up', 'on', 'be',
);

/** Greeting words. They are also read fillers ("hi, show me leads"), so
 * acknowledgements and adjectives ("great", "cool") never go here: "show
 * great customers" would become every customer. */
export const GREETINGS = set(
  'hi', 'hii', 'hello', 'hey', 'heya', 'hiya', 'yo', 'thanks', 'thank', 'thx', 'ty', 'cheers', 'greetings',
  'namaste', 'vanakkam',
);
/** Words that may sit next to a greeting ("good morning team", "thanks a
 * lot", "great, thanks", "no thanks", "thanks, that's all", "got it, thanks").
 * Read only by the whole-message small talk check, so a bare "ok", "cool" or
 * "no" (a reply to the existing assistant's question) is never small talk. */
export const GREETING_EXTRAS = set(
  'good', 'morning', 'afternoon', 'evening', 'day', 'there', 'team', 'everyone', 'bot', 'assistant',
  'so', 'much', 'lot', 'very', 'you', 'a', 'again', 'buddy',
  'great', 'perfect', 'nice', 'cool', 'awesome', 'no', 'that', 'thats', 'got', 'it',
);
/** Thanks words. The ones that aren't GREETINGS ("tnx", "tq") are read only
 * by the whole-message small talk check. */
export const THANKS_WORDS = set('thanks', 'thank', 'thx', 'ty', 'cheers', 'tnx', 'thnx', 'thanx', 'tq');
/** Goodbyes ("ok bye"); "good night" is a greeting phrase (parse.ts). Read
 * only by the whole-message small talk check, never fillers. */
export const FAREWELLS = set('bye', 'goodbye', 'byebye', 'cya');

export const HELP_WORD = 'help';
/** Whole-message help questions, matched on the words as typed
 * (punctuation dropped, a leading greeting or "please" ignored). */
export const HELP_PHRASES: ReadonlySet<string> = set(
  'what can you do', 'what can i ask', 'what can i ask you', 'what do you do', 'how can you help',
  'how can you help me', 'what can you help with', 'what can you help me with', 'how do i use this',
  'how does this work', 'what are you', 'what can you do for me', 'who are you', 'what can you help me do',
);

/** Greetings and thanks in Hindi and Tamil script, as whole messages.
 * tokenize() drops combining marks (नमस्ते becomes "नमस" and "त"), so these
 * are never words: parse.ts matches the whole message against them (NFC,
 * trimmed, punctuation and emoji at either end removed). */
export const NATIVE_SMALL_TALK: ReadonlyMap<string, 'hello' | 'thanks'> = new Map(([
  ['नमस्ते', 'hello'], ['नमस्कार', 'hello'], ['वणक्कम्', 'hello'], ['வணக்கம்', 'hello'],
  ['धन्यवाद', 'thanks'], ['शुक्रिया', 'thanks'], ['நன்றி', 'thanks'],
] as const).map(([phrase, variant]): [string, 'hello' | 'thanks'] => [phrase.normalize('NFC'), variant]));

/** Create, update and delete verbs (plan 4.2). */
export const CREATE_VERBS = set('create', 'add', 'new', 'raise', 'draft', 'log');
export const UPDATE_VERBS = set('update', 'change', 'set', 'edit', 'mark', 'move', 'assign');
export const DELETE_VERBS = set('delete', 'remove');
export const WRITE_VERBS: ReadonlySet<string> = new Set([...CREATE_VERBS, ...UPDATE_VERBS, ...DELETE_VERBS]);

/** With a write verb, these make it configuration wording (legacy config tools). */
export const CONFIG_NOUNS = set(
  'field', 'fields', 'module', 'modules', 'column', 'columns', 'dropdown', 'dropdowns', 'option', 'options',
  'required', 'unique', 'picklist',
);

/** Words that may come before a write verb ("please create", "can you add",
 * "hi, raise ..."). */
export const POLITE_PREFIX = set(
  'please', 'pls', 'plz', 'kindly', 'can', 'could', 'would', 'will', 'you', 'u', 'i', 'we', 'want', 'wanna',
  'need', 'to', 'like', 'lets', 'let', 'us', 'me', 'help', 'hey', 'hi', 'hello', 'ok', 'okay', 'just',
  'quickly', 'go', 'ahead', 'and', 'also', 'now', 'then', 'so', 'pl',
);

/** Source qualifiers, accepted only when they match the module's group. */
export const SOURCE_PHRASES: ReadonlyArray<{ words: string[]; source: 'native_crm' | 'field_service' }> = [
  { words: ['native', 'crm'], source: 'native_crm' },
  { words: ['field', 'service'], source: 'field_service' },
  { words: ['field', 'services'], source: 'field_service' },
  { words: ['fieldservice'], source: 'field_service' },
];

/** Not grammar v0: anything that narrows or orders the answer. Each word
 * maps to the filter key reported (keys only, never values). */
export const FILTER_WORDS: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  const add = (key: string, ...words: string[]) => words.forEach((w) => { map[w] = key; });
  add('mine', 'my', 'mine', 'myself', 'own');
  add('owner', 'assigned', 'unassigned', 'owned', 'owner', 'assignee');
  add('date', 'today', 'tomorrow', 'yesterday', 'tonight', 'week', 'weeks', 'month', 'months', 'year', 'years',
    'quarter', 'day', 'days', 'daily', 'weekly', 'monthly', 'since', 'before', 'after', 'between', 'until', 'till',
    'last', 'next', 'date', 'dates', 'due', 'created', 'updated', 'scheduled', 'ago',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
    'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
  add('status', 'open', 'closed', 'overdue', 'pending', 'active', 'inactive', 'completed', 'complete', 'cancelled',
    'canceled', 'paid', 'unpaid', 'won', 'lost', 'done', 'upcoming', 'expiring', 'expired', 'approved', 'rejected',
    'status', 'stage', 'converted', 'hot', 'cold', 'warm', 'late', 'stuck');
  add('amount', 'more', 'less', 'than', 'over', 'under', 'above', 'below', 'least', 'most', 'amount', 'value',
    'worth', 'lakh', 'lakhs', 'crore', 'crores', 'k', 'thousand', 'million', 'rs', 'inr', 'usd', 'price', 'revenue');
  add('sort', 'top', 'highest', 'lowest', 'largest', 'biggest', 'smallest', 'sort', 'sorted', 'order', 'ordered',
    'latest', 'newest', 'oldest', 'recent', 'recently', 'first', 'by', 'per', 'group', 'grouped', 'average', 'avg',
    'sum', 'compare', 'versus', 'vs');
  add('relation', 'with', 'without', 'no', 'none', 'having', 'who', 'whose', 'where', 'not', 'for', 'at', 'linked',
    'related');
  add('focus', 'this', 'that', 'these', 'those', 'it', 'them', 'its', 'same');
  return map;
})();
