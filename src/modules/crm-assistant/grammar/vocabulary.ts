import type { QueryPlan, RelRange } from '../contracts/plan';

/* Grammar v1 vocabulary (Increment 3): the fixed English words and phrases
 * the parser matches, always as whole lower-cased words (tokens.ts), never
 * as substrings. The tenant's own words (stage labels, enum values, field
 * labels) come from GrammarModuleInfo (context.ts) and module names from the
 * registry synonyms. Number syntax (lakh, crore, currency markers) is in
 * numbers.ts; dates are put together in dates.ts. The "mine" phrases
 * (Increment 4) come next to last; the words of Increment 5 (documents,
 * relations, named metrics, Custom Module search) follow, then the words of
 * Increment 6 (date-times and the write grammar, write.ts), and the words of
 * Increment 8 (charts, pipelines and the agenda, agenda.ts) are at the end. */

type Phrase = readonly string[];

/** Longer messages are never short commands (parse.ts re-exports it). */
export const MAX_GRAMMAR_WORDS = 30;

/* ── Connectors (count-only in Increment 3) ───────────────────────────── */

/** The same union as registry/connectors.ts ConnectorType. */
export type ConnectorType = 'zoho' | 'salesforce' | 'hubspot';

/** Vendor names. A vendor phrase wins over registry module words in the same
 * message: "how many hubspot companies" is HubSpot Companies. everyday: also
 * an everyday phrase, which is not the vendor after VENDOR_DETERMINERS ("our
 * sales force" is a sales team). */
export const CONNECTOR_PHRASES: ReadonlyArray<{ words: Phrase; type: ConnectorType; everyday?: true }> = [
  { words: ['zoho'], type: 'zoho' },
  { words: ['zoho', 'crm'], type: 'zoho' },
  { words: ['salesforce'], type: 'salesforce' },
  { words: ['salesforce', 'crm'], type: 'salesforce' },
  { words: ['sales', 'force'], type: 'salesforce', everyday: true },
  { words: ['sfdc'], type: 'salesforce' },
  { words: ['hubspot'], type: 'hubspot' },
  { words: ['hubspot', 'crm'], type: 'hubspot' },
  { words: ['hub', 'spot'], type: 'hubspot' },
  // "Zoho's deals": the tokenizer drops the apostrophe.
  { words: ['zohos'], type: 'zoho' },
  { words: ['salesforces'], type: 'salesforce' },
  { words: ['hubspots'], type: 'hubspot' },
];

/** Before an everyday vendor phrase, these make it the everyday phrase. */
export const VENDOR_DETERMINERS: ReadonlySet<string> = new Set(['our', 'the', 'my', 'your', 'their']);

/** Words that, right before a vendor name, make it a passing mention rather
 * than where the counted records are: "how many tickets about hubspot", "how
 * many companies like hubspot", "how many customers have zoho". */
export const VENDOR_MENTION_WORDS: ReadonlySet<string> = new Set([
  'about', 'like', 'have', 'has', 'use', 'uses', 'using',
]);

/** Words after a vendor that name its deal or customer module, whatever the
 * vendor calls it (Zoho Deals or Potentials, Salesforce Opportunities and
 * Accounts, HubSpot Deals and Companies). */
export const CONNECTOR_CONCEPT_WORDS: Readonly<Record<string, 'deal' | 'customer'>> = {
  deal: 'deal', deals: 'deal', opportunity: 'deal', opportunities: 'deal', potential: 'deal', potentials: 'deal',
  account: 'customer', accounts: 'customer', company: 'customer', companies: 'customer',
  customer: 'customer', customers: 'customer', organisation: 'customer', organisations: 'customer',
  organization: 'customer', organizations: 'customer',
};

/** Words that never belong to a stored connector module name (a verb or a
 * time word around the module): "how many leads came from hubspot". Tense
 * words refuse a connector count too ("how many leads did our sales force
 * close"), also those grammar v1 otherwise reads as fillers ("were", "was"),
 * and so do possessives ("how many tickets in their zoho": whose?). */
export const STORED_MODULE_STOP_WORDS: ReadonlySet<string> = new Set([
  'came', 'come', 'comes', 'coming', 'got', 'gotten', 'made', 'make', 'makes', 'sent', 'synced', 'sync',
  'imported', 'import', 'exported', 'generated', 'received', 'brought', 'were', 'was', 'did', 'been',
  'whats', 'what', 'which', 'who', 'whom', 'when', 'how', 'why', 'much',
  'their', 'theirs', 'your', 'yours', 'his', 'her', 'hers', 'ours',
]);

/** In a connector count, "and" between two module words joins two modules
 * ("how many zoho sales orders and invoices"), never one stored module's
 * name; "or" always asks about two. Either refuses the count; a leading "and"
 * ("and how many zoho deals?") does not. */
export const AND_WORD = 'and';

/** Words that otherwise narrow or order an answer (tokens.ts FILTER_WORDS)
 * but also name vendor modules ("Price Books", "Sales Order"). */
export const STORED_MODULE_NOUNS: ReadonlySet<string> = new Set(['price', 'order']);

/** Connector Leads and Contacts live in the legacy Customer collection, which
 * the assistant engine never reads (D11): they stay with the existing
 * assistant, also among other words ("how many zoho leads and contacts"). */
export const EXCLUDED_CONNECTOR_MODULES: ReadonlySet<string> = new Set(['lead', 'leads', 'contact', 'contacts']);

/** Stored module names the assistant may name: letters, digits and spaces. */
export const STORED_MODULE_NAME_RE = /^[a-z0-9]+(?: [a-z0-9]+)*$/;
export const MAX_STORED_MODULE_NAME = 60;

/* ── The customer concept (D1) ────────────────────────────────────────── */

/** "how many customers" with no source qualifier counts every source on
 * its own. "field service customers" keeps the Field Service module count. */
export const CUSTOMER_CONCEPT_WORDS: ReadonlySet<string> = new Set(['customer', 'customers', 'client', 'clients']);

/* ── Record states ─────────────────────────────────────────────────────── */

/** 'expiring' (Increment 5) is read by EXPIRING_PHRASES, only for modules that can expire. */
export type StateWord = 'open' | 'closed' | 'overdue' | 'due_today' | 'expiring';

/** Pending, active and the like are stage or enum words, not states. */
export const STATE_PHRASES: ReadonlyArray<{ words: Phrase; state: StateWord }> = [
  { words: ['open'], state: 'open' },
  { words: ['still', 'open'], state: 'open' },
  { words: ['closed'], state: 'closed' },
  { words: ['overdue'], state: 'overdue' },
  { words: ['past', 'due'], state: 'overdue' },
  { words: ['due', 'today'], state: 'due_today' },
  { words: ['due', 'for', 'today'], state: 'due_today' },
  { words: ['due', 'by', 'today'], state: 'due_today' },
];

/** Outcome words: a {op:'outcome'} condition only when the tenant's stages
 * for the module tag that outcome (peekStages). */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  won: 'won', lost: 'lost', completed: 'completed', cancelled: 'cancelled', canceled: 'cancelled',
  paid: 'paid', approved: 'approved', scheduled: 'scheduled', active: 'active',
};

/* ── Dates ─────────────────────────────────────────────────────────────── */

/** Which of the module's dates a phrase is about. 'close' is the due date of
 * modules whose due date is a close date (deals, leads). */
export type DateSel = 'created' | 'due' | 'start' | 'end' | 'close';

export const DATE_FIELD_WORDS: Readonly<Record<string, DateSel>> = {
  created: 'created', added: 'created', joined: 'created',
  due: 'due',
  scheduled: 'start', starting: 'start', starts: 'start', start: 'start',
  closing: 'close', close: 'close', closes: 'close',
  ending: 'end', ends: 'end', expiring: 'end', expires: 'end',
};

export const REL_RANGE_PHRASES: ReadonlyArray<{ words: Phrase; rel: RelRange }> = [
  { words: ['today'], rel: 'today' }, { words: ['todays'], rel: 'today' },
  { words: ['yesterday'], rel: 'yesterday' }, { words: ['yesterdays'], rel: 'yesterday' },
  { words: ['tomorrow'], rel: 'tomorrow' }, { words: ['tomorrows'], rel: 'tomorrow' },
  { words: ['this', 'week'], rel: 'this_week' }, { words: ['this', 'weeks'], rel: 'this_week' },
  { words: ['current', 'week'], rel: 'this_week' },
  { words: ['last', 'week'], rel: 'last_week' }, { words: ['last', 'weeks'], rel: 'last_week' },
  { words: ['previous', 'week'], rel: 'last_week' },
  { words: ['next', 'week'], rel: 'next_week' }, { words: ['next', 'weeks'], rel: 'next_week' },
  { words: ['coming', 'week'], rel: 'next_week' },
  { words: ['this', 'month'], rel: 'this_month' }, { words: ['this', 'months'], rel: 'this_month' },
  { words: ['current', 'month'], rel: 'this_month' },
  { words: ['last', 'month'], rel: 'last_month' }, { words: ['last', 'months'], rel: 'last_month' },
  { words: ['previous', 'month'], rel: 'last_month' },
  { words: ['next', 'month'], rel: 'next_month' }, { words: ['next', 'months'], rel: 'next_month' },
  { words: ['coming', 'month'], rel: 'next_month' },
  { words: ['this', 'quarter'], rel: 'this_quarter' }, { words: ['this', 'quarters'], rel: 'this_quarter' },
  { words: ['current', 'quarter'], rel: 'this_quarter' },
  { words: ['last', 'quarter'], rel: 'last_quarter' }, { words: ['last', 'quarters'], rel: 'last_quarter' },
  { words: ['previous', 'quarter'], rel: 'last_quarter' },
  { words: ['this', 'year'], rel: 'this_year' }, { words: ['this', 'years'], rel: 'this_year' },
  { words: ['current', 'year'], rel: 'this_year' },
  { words: ['last', 'year'], rel: 'last_year' }, { words: ['last', 'years'], rel: 'last_year' },
  { words: ['previous', 'year'], rel: 'last_year' },
  { words: ['last', '7', 'days'], rel: 'last_7_days' }, { words: ['past', '7', 'days'], rel: 'last_7_days' },
  { words: ['last', 'seven', 'days'], rel: 'last_7_days' }, { words: ['past', 'seven', 'days'], rel: 'last_7_days' },
  { words: ['past', 'week'], rel: 'last_7_days' },
  { words: ['next', '7', 'days'], rel: 'next_7_days' }, { words: ['next', 'seven', 'days'], rel: 'next_7_days' },
  { words: ['coming', '7', 'days'], rel: 'next_7_days' },
  { words: ['last', '30', 'days'], rel: 'last_30_days' }, { words: ['past', '30', 'days'], rel: 'last_30_days' },
  { words: ['last', 'thirty', 'days'], rel: 'last_30_days' }, { words: ['past', 'thirty', 'days'], rel: 'last_30_days' },
  { words: ['past', 'month'], rel: 'last_30_days' },
  { words: ['next', '30', 'days'], rel: 'next_30_days' }, { words: ['next', 'thirty', 'days'], rel: 'next_30_days' },
  { words: ['coming', '30', 'days'], rel: 'next_30_days' },
];

/** Words that may introduce a date range or a day ("in October", "during
 * last month", "for today", "over the last 7 days"). */
export const DATE_PREFIXES: ReadonlyArray<Phrase> = [
  ['in'], ['on'], ['during'], ['within'], ['for'],
  ['in', 'the'], ['on', 'the'], ['during', 'the'], ['within', 'the'], ['for', 'the'], ['over', 'the'],
];

/** "since Monday" (on or after), "before", "after", "until". */
export const DATE_BOUND_WORDS: Readonly<Record<string, 'gte' | 'gt' | 'lt' | 'lte'>> = {
  since: 'gte', before: 'lt', after: 'gt', until: 'lte', till: 'lte',
};

/** Two-word bounds: "up to today" is on or before today, as "until today". */
export const DATE_BOUND_PHRASES: ReadonlyArray<{ words: Phrase; op: 'gte' | 'gt' | 'lt' | 'lte' }> = [
  { words: ['up', 'to'], op: 'lte' }, { words: ['up', 'till'], op: 'lte' },
];

export const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

/** ISO weekday numbers (Monday 1 ... Sunday 7). */
export const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};

export const ORDINAL_SUFFIXES: ReadonlySet<string> = new Set(['st', 'nd', 'rd', 'th']);

/* ── Amounts ───────────────────────────────────────────────────────────── */

export type AmountOp = 'gt' | 'gte' | 'lt' | 'lte';

export const AMOUNT_COMPARATORS: ReadonlyArray<{ words: Phrase; op: AmountOp }> = [
  { words: ['more', 'than'], op: 'gt' }, { words: ['over'], op: 'gt' }, { words: ['above'], op: 'gt' },
  { words: ['greater', 'than'], op: 'gt' }, { words: ['higher', 'than'], op: 'gt' }, { words: ['exceeding'], op: 'gt' },
  { words: ['at', 'least'], op: 'gte' }, { words: ['minimum', 'of'], op: 'gte' },
  { words: ['less', 'than'], op: 'lt' }, { words: ['under'], op: 'lt' }, { words: ['below'], op: 'lt' },
  { words: ['lower', 'than'], op: 'lt' },
  { words: ['at', 'most'], op: 'lte' }, { words: ['up', 'to'], op: 'lte' }, { words: ['maximum', 'of'], op: 'lte' },
  { words: ['not', 'more', 'than'], op: 'lte' }, { words: ['no', 'more', 'than'], op: 'lte' },
];

/** Comparators may follow "worth" or "valued" ("worth more than 1 lakh"). */
export const AMOUNT_LEADS: ReadonlyArray<Phrase> = [['worth'], ['valued'], ['valued', 'at'], ['priced'], ['costing']];

/** "1 lakh and above", "5000 or less". */
export const AMOUNT_OPEN_ENDS: ReadonlyArray<{ words: Phrase; op: AmountOp }> = [
  { words: ['and', 'above'], op: 'gte' }, { words: ['or', 'above'], op: 'gte' }, { words: ['or', 'more'], op: 'gte' },
  { words: ['and', 'more'], op: 'gte' }, { words: ['plus'], op: 'gte' },
  { words: ['and', 'below'], op: 'lte' }, { words: ['or', 'below'], op: 'lte' }, { words: ['or', 'less'], op: 'lte' },
  { words: ['and', 'less'], op: 'lte' }, { words: ['and', 'under'], op: 'lte' },
];

/** Words that name a module's main amount, whatever its label. */
export const AMOUNT_FIELD_WORDS: ReadonlyArray<Phrase> = [['amount'], ['value']];

/* ── Sort, top N, breakdowns ───────────────────────────────────────────── */

export type SortWordTarget = 'created' | 'amount';

export const SORT_WORDS: ReadonlyArray<{ words: Phrase; by: SortWordTarget; dir: 'asc' | 'desc' }> = [
  { words: ['latest'], by: 'created', dir: 'desc' }, { words: ['newest'], by: 'created', dir: 'desc' },
  { words: ['recent'], by: 'created', dir: 'desc' }, { words: ['most', 'recent'], by: 'created', dir: 'desc' },
  { words: ['recently', 'added'], by: 'created', dir: 'desc' }, { words: ['recently', 'created'], by: 'created', dir: 'desc' },
  { words: ['oldest'], by: 'created', dir: 'asc' },
  { words: ['highest'], by: 'amount', dir: 'desc' }, { words: ['largest'], by: 'amount', dir: 'desc' },
  { words: ['biggest'], by: 'amount', dir: 'desc' }, { words: ['most', 'expensive'], by: 'amount', dir: 'desc' },
  { words: ['most', 'valuable'], by: 'amount', dir: 'desc' },
  { words: ['lowest'], by: 'amount', dir: 'asc' }, { words: ['smallest'], by: 'amount', dir: 'asc' },
  { words: ['cheapest'], by: 'amount', dir: 'asc' }, { words: ['least', 'expensive'], by: 'amount', dir: 'asc' },
];

/** "<sort word> first" says the same ("newest first"). */
export const SORT_WORD_TAIL: Phrase = ['first'];

/** Explicit sort ("sorted by amount", "order by close date"). */
export const SORT_BY_PHRASES: ReadonlyArray<Phrase> = [
  ['sorted', 'by'], ['sort', 'by'], ['order', 'by'], ['ordered', 'by'], ['arranged', 'by'], ['sorted', 'on'],
];

export const SORT_DIRECTIONS: ReadonlyArray<{ words: Phrase; dir: 'asc' | 'desc' }> = [
  { words: ['asc'], dir: 'asc' }, { words: ['ascending'], dir: 'asc' }, { words: ['low', 'to', 'high'], dir: 'asc' },
  { words: ['lowest', 'first'], dir: 'asc' }, { words: ['smallest', 'first'], dir: 'asc' },
  { words: ['oldest', 'first'], dir: 'asc' }, { words: ['earliest', 'first'], dir: 'asc' },
  { words: ['a', 'to', 'z'], dir: 'asc' },
  { words: ['desc'], dir: 'desc' }, { words: ['descending'], dir: 'desc' }, { words: ['high', 'to', 'low'], dir: 'desc' },
  { words: ['highest', 'first'], dir: 'desc' }, { words: ['largest', 'first'], dir: 'desc' },
  { words: ['newest', 'first'], dir: 'desc' }, { words: ['latest', 'first'], dir: 'desc' },
  { words: ['z', 'to', 'a'], dir: 'desc' },
  { words: ['ascending', 'order'], dir: 'asc' }, { words: ['in', 'ascending', 'order'], dir: 'asc' },
  { words: ['descending', 'order'], dir: 'desc' }, { words: ['in', 'descending', 'order'], dir: 'desc' },
];

/** "top 5 deals". */
export const TOP_WORD = 'top';

/** Breakdowns: "leads by source", "count leads per status", "work orders per
 * month". "by" alone means a breakdown only for a groupable field; an
 * explicit sort phrase always means a sort. */
export const GROUP_BY_PHRASES: ReadonlyArray<Phrase> = [
  ['per'], ['grouped', 'by'], ['group', 'by'], ['split', 'by'], ['broken', 'down', 'by'], ['breakdown', 'by'],
];
export const BY_WORD = 'by';
/** "leads each month". Only before a date bucket. */
export const EACH_WORD = 'each';

/** Words that ask for a breakdown; the message must also say by what. */
export const BREAKDOWN_PHRASES: ReadonlyArray<Phrase> = [
  ['breakdown'], ['breakdown', 'of'], ['break', 'down'], ['broken', 'down'], ['split', 'of'],
];

export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const BUCKET_WORDS: Readonly<Record<string, Bucket>> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month',
  quarter: 'quarter', quarters: 'quarter', year: 'year', years: 'year',
};

/** Small numbers written as words ("top five deals", "last seven days"). */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30,
};

/* ── Field words ───────────────────────────────────────────────────────── */

/** Extra names of the module's stage field ("leads by stage"). */
export const STAGE_FIELD_WORDS: ReadonlyArray<Phrase> = [
  ['stage'], ['stages'], ['status'], ['statuses'], ['pipeline', 'stage'],
];

/** Extra names of the module's created date ("sorted by creation date"). */
export const CREATED_FIELD_WORDS: ReadonlyArray<Phrase> = [
  ['created'], ['created', 'date'], ['creation', 'date'], ['date', 'created'], ['date', 'added'],
];

/** "<stage> stage" / "<stage> status" ("deals in proposal stage"). */
export const STAGE_TAILS: ReadonlyArray<Phrase> = [['stage'], ['status']];

/** Enum fields whose values are module names: relations arrive in Increment
 * 5, so "deal tasks" is not read as relatedModule = deal. */
export const ENUM_FIELDS_NOT_WORDS: ReadonlySet<string> = new Set(['relatedModule']);

/** Stored values too vague to stand alone as a filter ("show other leads"
 * asks for different leads, not source Other); they still work next to
 * their field's label ("other source leads", "source other"). */
export const VAGUE_VALUE_WORDS: ReadonlySet<string> = new Set(['other', 'others', 'none', 'unknown', 'misc', 'na', 'general']);

/** Other ways people write some stored values. */
export const VALUE_ALIASES: Readonly<Record<string, ReadonlyArray<Phrase>>> = {
  onleave: [['on', 'leave']],
  todo: [['to', 'do']],
};

/* ── Fillers ───────────────────────────────────────────────────────────── */

/** Grammar v1 words that never change what is asked, besides tokens.ts FILLERS.
 * Not "did": "how many deals did we close last month" asks what happened then,
 * which the record's own dates don't say. */
export const V1_FILLERS: ReadonlySet<string> = new Set(['were', 'was', 'been', 'only']);

/** tokens.ts FILLERS that grammar v1 never reads past: "invoices to be paid",
 * "tasks about to be overdue" are the opposite of the stage or state after "be".
 * Such a message is refused on purpose, even where grammar v0 reads it plainly
 * ("how many leads will there be"). */
export const V1_NOT_FILLERS: ReadonlySet<string> = new Set(['be']);

/** "I" is a filler only before these ("can I see", "I want", "I need").
 * "leads I created", "calls I made", "deals do I have" are about the
 * caller's own records, never everyone's: they are read as "mine"
 * (MINE_PHRASES). Any other "I" refuses the message on purpose, even where
 * grammar v0 reads it plainly ("how many tasks do I need to do", "deals I
 * have to close"). */
export const I_WORD = 'i';
export const I_FOLLOWERS: ReadonlySet<string> = new Set([
  'want', 'wanna', 'need', 'would', 'like', 'see', 'get', 'view', 'find', 'know', 'check', 'look',
]);
/** Of I_FOLLOWERS, the words of wanting ("I want", "I would like", "I need").
 * After them "to" ("wanna" has it) must lead to I_SEE_VERBS: "I want to see
 * overdue invoices" asks for records, "what do I need to do today" and "deals
 * I want to close" ask about the caller's own work. */
export const I_WANT_WORDS: ReadonlySet<string> = new Set(['want', 'wanna', 'need', 'would', 'like']);
export const I_SEE_VERBS: ReadonlySet<string> = new Set([
  'see', 'view', 'find', 'know', 'check', 'look', 'get', 'show', 'list', 'display',
]);

/** "get" asks for records at the start of a message ("get paid invoices",
 * "can I get the open tickets"); later, before a stage, state or value (with
 * only fillers between: "to get to qualified", "to get all paid"), it means
 * the records are not there yet ("invoices to get paid"). */
export const GET_WORD = 'get';

/** The task module's words "to do" ("to-do") and "todo". Right after one of
 * AGENDA_LEADS ("all" and "else" may come between) they are the verb, not the
 * list: "what do we need to do today", "what do we have to do", "what is
 * there to do", "what all to do today" ask for an agenda, never a task read
 * (agenda.ts reads them since Increment 8); "show to do tasks", "tasks to do"
 * still read. */
export const TO_DO_WORDS: ReadonlySet<string> = new Set(['to do', 'todo']);
export const AGENDA_LEADS: ReadonlySet<string> = new Set([
  'need', 'needs', 'have', 'has', 'got', 'want', 'wants', 'like', 'what', 'whats', 'there',
]);
export const AGENDA_GAP_WORDS: ReadonlySet<string> = new Set(['all', 'else']);

/** "total" counts what it comes before ("total overdue invoices", "total
 * number of leads"). After the module ("expenses total") or before "of" ("the
 * total of overdue invoices") it is a sum, which grammar v1 doesn't read,
 * unless it names a metric ("invoice total": METRIC_PHRASES). */
export const TOTAL_WORD = 'total';
export const OF_WORD = 'of';

/** Multi-word fillers ("invoices that are overdue"). */
export const V1_FILLER_PHRASES: ReadonlyArray<Phrase> = [
  ['that', 'are'], ['that', 'were'], ['which', 'are'], ['which', 'were'], ['that', 'is'], ['which', 'is'],
  ['right', 'now'], ['as', 'of', 'now'],
];

/** Joins values of one field ("new or contacted leads"). */
export const OR_WORD = 'or';

/* ── "Mine" (Increment 4) ──────────────────────────────────────────────── */

/** plan.mine. The grammar only says which records are the caller's own;
 * what that means in each module (the owner field, the staff list, the
 * creator) is query/mine.ts's, from the verified identity. */
export type MineMode = NonNullable<QueryPlan['mine']>;

/** Where a "mine" phrase stands: 'before' the module ("my leads", "how many
 * of my deals"), 'after' it ("deals assigned to me", "leads I created",
 * "leads of mine"), 'any' ("do I have any open tasks", "how many deals do I
 * have"), or 'tail': right after a created date ("leads created this week
 * by me"). Anywhere else it says nothing about that module's records. */
export type MinePlace = 'before' | 'after' | 'any' | 'tail';

export interface MinePhrase {
  words: Phrase;
  mode: MineMode;
  place: MinePlace;
  /** The phrase is the caller's "I" ("leads I own"); anywhere else that "I" refuses the message as any other "I" does. */
  saysI?: true;
  /** Not "mine" before these words: "my team's leads" are the team's, "my
   * company" is the caller's employer; "deals I have to close" are the caller's own work. */
  notBefore?: ReadonlySet<string>;
  /** "have" may be what the caller did: right before a finished state, an
   * outcome, a finished stage or a value named by a past participle, with no
   * module name after it ("tickets I have resolved", "deals I have closed",
   * "expenses I have approved", "leads I have contacted"), it is not "mine".
   * Before any other state or value it is what the caller has ("how many deals
   * do I have open", "tasks I have overdue", "leads I have hot"), as before a
   * module name ("do I have open tasks") or a filler ("deals I have in
   * negotiation"). */
  auxiliary?: true;
  /** "leads I created", "tickets raised by me": a date right after it is when the record was created (MINE_EVENT_VERBS aside). */
  verb?: string;
}

/** Verbs that make "mine" the records the caller created. */
const MINE_CREATED_VERBS: readonly string[] = ['created', 'made', 'added', 'raised', 'logged'];

/** After these, a call's or meeting's date is when it took place ("calls I
 * made today", "meetings I logged yesterday"). After the other verbs, and in
 * other modules, a date is when the record was created ("tasks I created
 * this week" are not tasks due this week; "invoices I raised this month"). */
export const MINE_EVENT_VERBS: ReadonlySet<string> = new Set(['made', 'logged']);

/** After "my", the caller's team or employer, not records they own: "my
 * team", "my company", "my organisation" ("my companies" are records). */
const MY_GROUP_WORDS: ReadonlySet<string> = new Set([
  'team', 'teams', 'company', 'organisation', 'organization', 'business',
]);
const TO_WORDS: ReadonlySet<string> = new Set(['to']);

/** Past participles that don't end in "ed" ("Done", "Sent"): a stage or value
 * named by one, right after "I have", is what the caller did (auxiliary). */
export const DONE_WORDS: ReadonlySet<string> = new Set(['done', 'won', 'lost', 'paid', 'sent', 'made', 'held', 'met']);

/** The caller's own records, as whole words. "me" alone stays a filler
 * ("show me leads"), "we", "our" and "us" are the team, "unassigned" and
 * "assigned to <name>" are not the caller, and "assign ... to me" is a write
 * (grammar v0). Phrases that are the caller's "I" may also follow "that"
 * ("deals that I own"; "which" is a filler already). */
export const MINE_PHRASES: ReadonlyArray<MinePhrase> = (() => {
  const own: MinePhrase[] = [
    { words: ['i', 'have'], mode: 'assigned', place: 'after', saysI: true, notBefore: TO_WORDS, auxiliary: true },
    { words: ['i', 'own'], mode: 'assigned', place: 'after', saysI: true },
    { words: ['im', 'assigned'], mode: 'assigned', place: 'after', saysI: true },
    { words: ['i', 'am', 'assigned'], mode: 'assigned', place: 'after', saysI: true },
    ...MINE_CREATED_VERBS.map((verb): MinePhrase => ({ words: ['i', verb], mode: 'created', place: 'after', saysI: true, verb })),
  ];
  const phrases: MinePhrase[] = [
    { words: ['my'], mode: 'assigned', place: 'before', notBefore: MY_GROUP_WORDS },
    { words: ['my', 'own'], mode: 'assigned', place: 'before', notBefore: MY_GROUP_WORDS },
    { words: ['my', 'assigned'], mode: 'assigned', place: 'before', notBefore: MY_GROUP_WORDS },
    { words: ['my', 'own', 'assigned'], mode: 'assigned', place: 'before', notBefore: MY_GROUP_WORDS },
    { words: ['mine'], mode: 'assigned', place: 'after' },
    { words: ['do', 'i', 'have'], mode: 'assigned', place: 'any', saysI: true, notBefore: TO_WORDS, auxiliary: true },
    ...own,
    ...own.map((p) => ({ ...p, words: ['that', ...p.words] })),
  ];
  for (const me of ['me', 'myself']) {
    phrases.push(
      { words: ['assigned', 'to', me], mode: 'assigned', place: 'after' },
      { words: ['owned', 'by', me], mode: 'assigned', place: 'after' },
      ...MINE_CREATED_VERBS.map((verb): MinePhrase => ({ words: [verb, 'by', me], mode: 'created', place: 'after', verb })),
      { words: ['by', me], mode: 'created', place: 'tail' },
    );
  }
  return phrases;
})();

/* ── Documents (Increment 5) ───────────────────────────────────────────── */

/** "expiring contracts", "quotations expiring soon", "about to expire",
 * "ending soon", "due to expire": the 'expiring' state, only for modules that
 * can expire (GrammarModuleInfo.expiring: contracts and quotations). A
 * relative range right after it is its window ("expiring this month",
 * "expiring in the next 7 days"; DATE_PREFIXES may come between), and so is
 * one written alone after the module ("expiring contracts this month"); with
 * none the window is the next 30 days (query/compile.ts). "ending" alone
 * stays the end date ("contracts ending this month"). */
export const EXPIRING_PHRASES: ReadonlyArray<Phrase> = [
  ['expiring'], ['expiring', 'soon'], ['expire'], ['expires'], ['expire', 'soon'], ['expires', 'soon'],
  ['about', 'to', 'expire'], ['due', 'to', 'expire'], ['going', 'to', 'expire'], ['that', 'expire'], ['that', 'expires'],
  ['ending', 'soon'], ['end', 'soon'], ['ends', 'soon'],
];

/** The windows "expiring" takes: from today on. A past one ("contracts
 * expiring last month", "expiring yesterday") asks which ran out then, while
 * the state reads only records still running: the planner reads it
 * (decision D14). */
export const EXPIRING_WINDOWS: ReadonlySet<RelRange> = new Set<RelRange>([
  'today', 'tomorrow', 'this_week', 'next_week', 'this_month', 'next_month', 'this_quarter', 'this_year', 'next_7_days',
  'next_30_days',
]);

/** "pending quotations", "quotations pending approval", "awaiting approval":
 * decision D4, for quotations only, all of them the same stage: the tenant's
 * own stage keyed or labelled "pending"; else its one approval stage of its
 * own (not finished, tagged with no outcome, not keyed 'sent', with "pending"
 * or "awaiting" in its key or label, or "approval" without "approved":
 * "Pending Approval", "Awaiting Approval", "Approval Pending"); else the stage
 * keyed 'sent' (pending approval is sent). A stage or value the tenant writes
 * with the same words keeps them (its own words always win). */
export const PENDING_APPROVAL: {
  module: string; own: string; stage: string; waiting: ReadonlySet<string>; approval: string; approved: string;
  words: ReadonlyArray<Phrase>;
} = {
  module: 'quotation',
  own: 'pending',
  stage: 'sent',
  waiting: new Set(['pending', 'awaiting']),
  approval: 'approval',
  approved: 'approved',
  words: [['pending'], ['pending', 'approval'], ['pending', 'for', 'approval'], ['awaiting', 'approval'], ['waiting', 'for', 'approval']],
};

/** "draft" is a create verb (tokens.ts CREATE_VERBS) and a stage. Right
 * before the plural name of a document the assistant reads but never writes
 * (registry/fs-documents.ts) it is that stage ("draft quotations", "draft
 * contracts"), as it is right after "with" or "in" for any module ("customers
 * with draft quotations", "invoices in draft"). "draft invoices" and "draft
 * work orders" stay writes: those can be created. */
export const DRAFT_WORD = 'draft';
export const DRAFT_DOCUMENTS: ReadonlySet<string> = new Set(['quotation', 'contract', 'receipt']);
export const DRAFT_STAGE_AFTER: ReadonlySet<string> = new Set(['with', 'in']);

/* ── Relations (Increment 5) ───────────────────────────────────────────── */

export type HasKind = 'has' | 'has_none';

const has = (...words: string[]) => ({ words, kind: 'has' as const });
const hasNone = (...words: string[]) => ({ words, kind: 'has_none' as const });
const neverInvoiced = (...words: string[]) => ({ words, kind: 'has_none' as const, child: 'invoice' });

/** "customers with invoices", "customers who have no invoices", "customers
 * without invoices": what follows is the related (child) module with its own
 * conditions ("customers with overdue invoices"), what comes before is the
 * target. `child`: the phrase names the related module itself ("customers
 * never invoiced"). Read only where no word of the target's own reads it
 * ("invoices no more than 5000" stays an amount). */
export const HAS_PHRASES: ReadonlyArray<{ words: Phrase; kind: HasKind; child?: string }> = [
  has('with'), has('having'), has('have'), has('has'), has('that', 'have'), has('that', 'has'), has('that', 'had'),
  has('who', 'have'), has('who', 'has'), has('who', 'had'), has('that', 'generated'), has('who', 'generated'), has('which', 'generated'),
  hasNone('without'), hasNone('with', 'no'), hasNone('with', 'zero'), hasNone('having', 'no'), hasNone('no'),
  hasNone('have', 'no'), hasNone('has', 'no'), hasNone('that', 'have', 'no'), hasNone('that', 'has', 'no'),
  hasNone('who', 'have', 'no'), hasNone('who', 'has', 'no'), hasNone('have', 'never', 'had'), hasNone('has', 'never', 'had'),
  hasNone('that', 'have', 'never', 'had'), hasNone('who', 'have', 'never', 'had'), hasNone('that', 'never', 'had'), hasNone('who', 'never', 'had'),
  neverInvoiced('never', 'invoiced'), neverInvoiced('never', 'been', 'invoiced'), neverInvoiced('were', 'never', 'invoiced'),
  neverInvoiced('who', 'were', 'never', 'invoiced'), neverInvoiced('that', 'were', 'never', 'invoiced'),
  neverInvoiced('have', 'never', 'been', 'invoiced'), neverInvoiced('who', 'have', 'never', 'been', 'invoiced'),
  neverInvoiced('that', 'have', 'never', 'been', 'invoiced'),
];

/** "work orders for ABC Industries", "invoices of Kumar Traders", "invoices
 * for this work order", "work orders for customer ABC", "invoices for work
 * order <number>": the record named after it is a parent of the target's
 * records (registry/relations.ts). Read only where no word of the target's
 * own reads it ("for today" stays a date, "number of" a count). */
export const FOR_WORDS: ReadonlySet<string> = new Set(['for', 'of']);
/** "for this work order": the record on screen. */
export const FOCUS_WORDS: ReadonlySet<string> = new Set(['this', 'that']);
/** "for a customer named ABC": skipped right after the parent's module word. */
export const NAMED_WORDS: ReadonlySet<string> = new Set(['named', 'called']);
/** A record named in words, or a Custom Module search, has at most this many words. */
export const MAX_NAME_WORDS = 8;

/** Words that never start a name nor make one alone ("leads for me",
 * "invoices for next month", "invoices of all customers"): pronouns,
 * determiners, question words, prepositions ("for customer at Chennai") and
 * time words (weekdays written out only: "Sun Pharma" is a name). Inside a
 * name they are kept ("Bank of India"). */
export const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'me', 'myself', 'us', 'ourselves', 'you', 'yourself', 'yourselves', 'him', 'himself', 'her', 'herself', 'them', 'themselves',
  'it', 'its', 'itself', 'my', 'mine', 'our', 'ours', 'your', 'yours', 'his', 'hers', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'the', 'a', 'an', 'all', 'each', 'every', 'any', 'some', 'same', 'other', 'others', 'both',
  'either', 'neither', 'none', 'one', 'ones', 'everyone', 'everybody', 'anyone', 'anybody', 'someone', 'somebody',
  'something', 'anything', 'everything', 'what', 'whats', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'at', 'near',
  'today', 'todays', 'yesterday', 'tomorrow', 'tonight', 'now', 'day', 'days', 'week', 'weeks', 'month', 'months', 'quarter',
  'quarters', 'year', 'years', 'next', 'last', 'past', 'previous', 'coming', 'current', 'recent', 'recently',
  ...Object.keys(MONTH_NAMES), ...Object.keys(WEEKDAY_NAMES).filter((w) => w.endsWith('day')),
]);

/** With no parent module written ("work orders for X", not "for customer
 * X"), a first word that says when rather than whose: "for the weekend",
 * "for morning", "for Q3", "for H1", "for FY 2025", "for FY25"
 * (NAME_TIME_PATTERN; decision D6). The planner reads those. */
export const NAME_TIME_WORDS: ReadonlySet<string> = new Set([
  'weekend', 'weekends', 'morning', 'mornings', 'afternoon', 'afternoons', 'evening', 'evenings', 'night', 'nights', 'noon',
  'midnight', 'ytd', 'mtd', 'qtd',
]);
export const NAME_TIME_PATTERN = /^(q[1-4]|h[12]|fy\d{0,4})$/;

/** With no parent module written, a one-word "name" that says what for:
 * "contracts up for renewal", "quotations for approval", "expenses for
 * travel" (decision D6), as does a value any of the caller's modules reads
 * on its own ("work orders for maintenance", "invoices for pending"). */
export const NAME_PURPOSE_WORDS: ReadonlySet<string> = new Set([
  'approval', 'renewal', 'review', 'payment', 'completion', 'repair', 'service', 'travel', 'fuel', 'upi',
]);

/** The only fillers a name may follow ("for the ABC Industries"). Any other
 * filler right before the words says they are no name: "for customer in
 * Chennai", "for staff from Pune", "for all customers". */
export const NAME_ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an']);

/** Field nouns a name never starts with, besides the target's own field
 * labels: "invoices of status paid", "receipts of method cash", "work orders
 * of type installation" name a field and its value, not a customer called
 * "status". */
export const NAME_FIELD_NOUNS: ReadonlySet<string> = new Set(['type', 'category', 'method', 'mode', 'date', 'amount', 'status']);

/** Words that end a name: the start of a relation, a search or a refusal
 * ("work orders for ABC with no invoices", "invoices for ABC I need"), and
 * words that sort, cut, break down, place or assign the records ("for ABC
 * sorted by date", "for ABC by technician", "for ABC in Chennai", "for ABC
 * assigned to Ravi", "for ABC unpaid"): what comes after them must be the
 * target's own words, or nothing is read. "of" stays inside a name ("Bank of
 * India"). */
export const NAME_END_WORDS: ReadonlySet<string> = new Set([
  'with', 'without', 'having', 'no', 'who', 'whose', 'that', 'which', 'have', 'has', 'had', 'never', 'for', 'i', 'be',
  'named', 'called', 'containing', 'matching',
  'sorted', 'sort', 'ordered', 'ascending', 'descending', 'asc', 'desc', 'limit', 'top', 'by', 'per', 'in',
  'assigned', 'unassigned', 'due', 'unpaid', 'accepted',
]);

/** Currency codes a company's Field Service currency may be
 * (native-crm.config.ts) that numbers.ts doesn't read as a currency: with a
 * number after them they are an amount, never a name ("invoices for AED
 * 5000", as "invoices for Rs 5000"). */
export const NAME_CURRENCY_CODES: ReadonlySet<string> = new Set(['aed', 'eur', 'gbp', 'sgd']);

/** Words that make what follows its opposite ("invoices for ABC not paid",
 * "... except paid", "... aren't paid": tokens.ts drops the apostrophe) or
 * only part of it ("... partially paid", "almost completed"). In an unquoted
 * name or right after it they leave no name to read, so the stage after them
 * is never read as asked for ("other" too, before "than": OTHER_THAN). A
 * quoted name keeps any words. "without", "no" and "never" are relation
 * words (HAS_PHRASES). */
export const NAME_NEGATION_WORDS: ReadonlySet<string> = new Set([
  'not', 'nor', 'non', 'except', 'excluding', 'exclude', 'excl', 'besides', 'apart', 'minus', 'unless', 'but',
  'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'hasnt', 'havent', 'hadnt', 'cant', 'cannot', 'wont',
  'partially', 'partly', 'almost', 'nearly', 'half',
]);
/** "invoices for ABC other than paid". */
export const OTHER_THAN: Phrase = ['other', 'than'];

/* ── Named metrics (Increment 5) ───────────────────────────────────────── */

/** Words for named metrics besides each MetricDef's own synonyms
 * (registry/metrics.ts). `context`: the word alone never asks ("invoiced"
 * may answer the assistant's own question), another part of the message must
 * ("billed per customer", "how much has each customer been invoiced"). */
export const METRIC_PHRASES: ReadonlyArray<{ words: Phrase; metric: string; context?: true }> = [
  { words: ['invoice', 'totals'], metric: 'purchase_amount' }, { words: ['invoice', 'total'], metric: 'purchase_amount' },
  { words: ['invoice', 'value'], metric: 'purchase_amount' }, { words: ['invoice', 'values'], metric: 'purchase_amount' },
  { words: ['invoiced'], metric: 'purchase_amount', context: true }, { words: ['billed'], metric: 'purchase_amount', context: true },
  { words: ['amount', 'due'], metric: 'outstanding' }, { words: ['balance', 'due'], metric: 'outstanding' },
  { words: ['total', 'due'], metric: 'outstanding' }, { words: ['owe'], metric: 'outstanding', context: true },
  { words: ['owes'], metric: 'outstanding', context: true }, { words: ['owed'], metric: 'outstanding', context: true },
  { words: ['money', 'collected'], metric: 'payments_received' },
];

/** "how much is outstanding": asks for a total, never on its own. */
export const HOW_MUCH: Phrase = ['how', 'much'];

/** A named metric's breakdown field (MetricDef.groupBy) and the module whose
 * own words name it ("per customer", "by client", "for each customer"). */
export const METRIC_GROUP_FIELDS: Readonly<Record<string, string>> = { customerId: 'customer' };
export const METRIC_GROUP_INTROS: ReadonlyArray<Phrase> = [
  ['per'], ['by'], ['each'], ['for', 'each'], ['of', 'each'], ['for', 'every'], ['grouped', 'by'], ['group', 'by'],
  ['split', 'by'], ['broken', 'down', 'by'], ['breakdown', 'by'],
];
/** "customer wise", "customerwise". */
export const METRIC_GROUP_TAIL = 'wise';
/** "customers by purchase amount", "customers ranked by outstanding": the
 * breakdown's module named first, then its metric (decision D10). */
export const METRIC_GROUP_FIRST: ReadonlyArray<Phrase> = [['by'], ['ranked', 'by']];
/** "compare customers by purchase amount", "rank customers by outstanding",
 * "top customers by payments received": a named metric per value of its
 * breakdown, largest first, as every such breakdown is (decision D10). Read
 * only with that breakdown ("top 5" too, as plan.top); "compare leads this
 * month with last month" is not read. */
export const METRIC_RANK_WORDS: readonly string[] = ['compare', 'rank', 'top'];

/** The date a date written alone is about, per named metric: payments by
 * their payment date (MetricDef.dateField), the won value by the deal's close
 * date ("won value this quarter"; Increment 8), the outstanding balance by the
 * invoice's due date ("outstanding this month": due this month). A purchase
 * amount has none ("invoiced this month": raised then, or due then?), and nor
 * has the pipeline value (what is open now), so a date alone is not read there. */
export const METRIC_BARE_DATES: Readonly<Record<string, 'metric' | 'due'>> = {
  payments_received: 'metric', won_value: 'metric', outstanding: 'due',
};

/* ── Custom Module search (Increment 5) ────────────────────────────────── */

/** "site visits named Acme", "jobs containing pump": the words after it
 * (MAX_NAME_WORDS at most, as written; quoted text keeps its words) are the
 * Custom Module's escaped text search. */
export const SEARCH_PHRASES: ReadonlyArray<Phrase> = [
  ['named'], ['called'], ['containing'], ['matching'], ['that', 'contain'], ['that', 'contains'], ['which', 'contain'],
  ['which', 'contains'],
];

/* ── Date-times for writes (Increment 6, dates.ts matchDateTimeAt) ─────── */

/** Two days on. "today", "tomorrow" and "yesterday" are REL_RANGE_PHRASES. */
export const DAY_AFTER_TOMORROW: Phrase = ['day', 'after', 'tomorrow'];
/** Words before a day or a time ("on Monday", "at 3pm", "by Friday 5pm").
 * A bare hour is a time only after "at" ("at 3"). */
export const DATE_TIME_JOINERS: ReadonlySet<string> = new Set(['at', 'on', 'by']);
/** "this Friday" (the next Friday after today) and "next Friday" (the Friday
 * of next Monday-to-Sunday week, decision L31). */
export const WEEKDAY_QUALIFIERS: ReadonlySet<string> = new Set(['this', 'next']);
/** "last Friday", "past Friday", "previous Friday": the latest Friday before
 * today (L31). */
export const PAST_WEEKDAY_QUALIFIERS: ReadonlySet<string> = new Set(['last', 'past', 'previous']);
/** Weekday abbreviations that are also everyday words: a day only after
 * one of those ("next sat", "last sun"), so "Sun Pharma" stays a name. */
export const QUALIFIED_ONLY_WEEKDAYS: ReadonlySet<string> = new Set(['sat', 'sun', 'wed']);
/** Times named by a word. Midnight is read only to be refused: a write never
 * gets it (L14). "morning", "afternoon" and "evening" name no time. */
export const CLOCK_WORDS: Readonly<Record<string, { hour: number; minute: number }>> = {
  noon: { hour: 12, minute: 0 }, midday: { hour: 12, minute: 0 }, midnight: { hour: 0, minute: 0 },
};
/** "in 2 hours", "in 30 mins", "in a week": the unit of a time from now. */
export const OFFSET_UNITS: Readonly<Record<string, 'minute' | 'hour' | 'day' | 'week'>> = {
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour',
  day: 'day', days: 'day', week: 'week', weeks: 'week',
};

/* ── The write grammar (Increment 6, write.ts) ─────────────────────────── */

/** At most one of these between a create verb and its module ("create a
 * task"), then perhaps "new" ("add a new lead"). */
export const CREATE_ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the', 'another', 'one']);
/** A create verb, and an adjective after an article ("create a new task"). */
export const NEW_WORD = 'new';
/** The title or name of a create follows them ("a work order called AC repair"). */
export const TITLE_WORDS: ReadonlySet<string> = new Set(['called', 'titled', 'named']);
/** Words that end a name read from a write ("for ABC Industries tomorrow",
 * "with Kumar at 4pm"): the start of another part of the request (spec B7). */
export const WRITE_NAME_END: ReadonlySet<string> = new Set([
  'for', 'with', 'to', 'at', 'on', 'by', 'assign', 'assigned', 'priority', 'status', 'due', 'called', 'named', 'titled',
]);
/** Also end the name of the record an update or delete names ("mark task
 * Call Ravi as done", "update lead Ravi set ..."). */
export const WRITE_TARGET_END: ReadonlySet<string> = new Set(['as', 'set']);
/** "assign to Ravi", "assigned to me". */
export const ASSIGN_WORDS: ReadonlySet<string> = new Set(['assign', 'assigned']);
/** Priority words besides the values themselves: "urgent" is high; "critical"
 * only where it is a value (tickets). */
export const PRIORITY_WORDS: Readonly<Record<string, string>> = { urgent: 'high', critical: 'critical' };
/** A call's direction ("an incoming call") and the status words a call create reads. */
export const CALL_DIRECTION_WORDS: Readonly<Record<string, string>> = {
  incoming: 'inbound', inbound: 'inbound', outgoing: 'outbound', outbound: 'outbound',
};
export const CALL_STATUS_WORDS: ReadonlySet<string> = new Set(['missed', 'completed', 'planned']);
/** Words a write or a typed answer may carry between its parts without
 * meaning ("for ABC and assign to me", "high please"). Inside a name or a
 * title they are kept ("Johnson and Johnson"). */
export const WRITE_FILLERS: ReadonlySet<string> = new Set(['and', 'also', 'then', 'please', 'pls', 'plz', 'kindly']);
/** What a field may be called besides its label (spec B7): the stage or
 * status field, the module's date, the priority, the title and the notes. */
export type WriteFieldRole = 'status' | 'date' | 'priority' | 'title' | 'notes';
export const WRITE_FIELD_SYNONYMS: ReadonlyArray<{ words: Phrase; role: WriteFieldRole }> = [
  { words: ['status'], role: 'status' }, { words: ['stage'], role: 'status' },
  { words: ['due'], role: 'date' }, { words: ['due', 'date'], role: 'date' }, { words: ['date'], role: 'date' },
  { words: ['priority'], role: 'priority' },
  { words: ['title'], role: 'title' }, { words: ['subject'], role: 'title' }, { words: ['name'], role: 'title' },
  { words: ['notes'], role: 'notes' },
];
/** Words between a field and its value ("priority to high", "status is
 * open"; "=" and ":" are no words). */
export const VALUE_JOINERS: ReadonlySet<string> = new Set(['to', 'is', 'as']);
/** "me" in a write: the caller ("assign to me"). */
export const ME_WORD = 'me';
/** A yes or no field answered in a word. */
export const YES_NO_WORDS: Readonly<Record<string, boolean>> = { yes: true, no: false };
/** A typed answer that closes the open form, or sends it for review: the
 * whole message, polite words aside (spec B7). */
export const FILL_CANCEL_PHRASES: ReadonlySet<string> = new Set([
  'cancel', 'cancel it', 'cancel this', 'cancel the form', 'never mind', 'nevermind',
]);
export const FILL_REVIEW_PHRASES: ReadonlySet<string> = new Set(['review', 'review it', 'done', 'submit', 'looks good']);
/** A document line's quantity written as a word ("with two AC service",
 * Increment 7): one to twenty. */
export const LINE_QTY_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/* ── Charts and pipelines (Increment 8, parse.ts) ──────────────────────── */

/** How a read is drawn (plan.present), or 'chart': a chart of no named kind,
 * which readCore writes as the kind that fits what is read. */
export type PresentWord = 'chart' | 'bar' | 'hbar' | 'line' | 'table' | 'pipeline';

const present = (kind: PresentWord, ...phrases: string[]) => phrases.map((p) => ({ words: p.split(' '), present: kind }));

/** "chart of work orders per month", "show tickets by priority as a chart",
 * "leads by source as a table", "line chart of leads per month", "tickets by
 * status as a pipeline": at most one in a message ("a", "in" and "of" are
 * fillers already, "as" is not, so each kind has its "as" forms: "as a bar
 * chart", "as a line chart"). "pie chart", "donut", "doughnut",
 * "histogram" and "scatter" name no kind the chat draws: their words are
 * unknown here, so the planner reads them. A phrase that also names one of
 * the module's stages or values keeps that meaning (a stage labelled
 * "Table"). */
export const PRESENT_PHRASES: ReadonlyArray<{ words: Phrase; present: PresentWord }> = [
  ...present('chart', 'chart', 'charts', 'graph', 'graphs', 'plot', 'visual', 'visualise', 'visualize', 'as a chart',
    'as chart', 'as a graph', 'as graph', 'in a chart', 'in a graph'),
  ...present('bar', 'bar chart', 'bar charts', 'bar graph', 'column chart', 'bars', 'as a bar chart', 'as bar chart',
    'as a bar graph', 'as a column chart', 'as bars'),
  ...present('hbar', 'horizontal bar chart', 'horizontal bar graph', 'horizontal bars', 'as a horizontal bar chart',
    'as horizontal bars'),
  ...present('line', 'line chart', 'line graph', 'trend', 'trends', 'trend line', 'as a line chart', 'as line chart',
    'as a line graph', 'as a trend'),
  ...present('table', 'table', 'tabular', 'as a table', 'as table', 'as a list', 'as list', 'table view'),
  ...present('pipeline', 'as a pipeline', 'as pipeline', 'pipeline view'),
];
/** In a name ("invoices for Trend Micro", "quotations for Pipeline Corp") the
 * words above and PIPELINE_WORDS are part of it, as before Increment 8; a
 * phrase that starts with "as" says how the read is drawn ("invoices for
 * Acme as a chart"; parse.ts segmentSpans). */
export const AS_WORD = 'as';

/** "monthly work orders this year", "work orders monthly", "monthly
 * collections": read as "per month" is (the same date), right before or
 * after the module's name or a named total only, never in a name ("invoices
 * of Annual") or before a value ("annual maintenance contracts"), and never
 * when the word is one of the module's values. */
export const BUCKET_ADJECTIVES: Readonly<Record<string, Bucket>> = {
  daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year', annual: 'year', annually: 'year',
};

/** "deal pipeline", "lead funnel", "deals kanban", "pipeline of deals": a
 * pipeline module's records counted per stage of its pipeline (plan.present
 * 'pipeline'). Longer phrases are read first: "pipeline value" is a named
 * metric, "pipeline stage" the stage field ("deals by pipeline stage"). A
 * word that also names one of the module's stages or values keeps that
 * meaning. */
export const PIPELINE_WORDS: ReadonlySet<string> = new Set(['pipeline', 'pipelines', 'funnel', 'kanban', 'board']);
/** The modules whose stages are a tenant pipeline, in the order bare
 * "pipeline" offers them (decision N25); no other module has a pipeline. */
export const PIPELINE_MODULES: readonly string[] = ['deal', 'lead', 'workorder', 'quotation', 'contract', 'invoice', 'task', 'ticket'];
/** "sales pipeline", "sales funnel": the deals', unless one of the caller's
 * Custom Modules is named so (parse.ts salesPipelineWords). */
export const SALES_PIPELINE: { module: string; words: ReadonlyArray<Phrase> } = {
  module: 'deal',
  words: [['sales', 'pipeline'], ['sales', 'pipelines'], ['sales', 'funnel']],
};
/** Bare "pipeline" with no module ("show me the pipeline", "my pipeline",
 * "open the pipeline"): which one is asked (decision N25). "open" is the verb
 * there, never the open state. */
export const BARE_PIPELINE_WORDS: ReadonlySet<string> = new Set(['pipeline', 'pipelines']);
export const OPEN_WORD = 'open';

/* ── The agenda (Increment 8, agenda.ts) ───────────────────────────────── */

/** What an agenda opener asks: 'overdue' what is overdue, 'upcoming' the next
 * 7 days unless a date is written, 'any' the date written, else everything
 * Daily Events shows. */
export type AgendaKind = 'any' | 'overdue' | 'upcoming';

const opener = (kind: AgendaKind, ...phrases: string[]) => phrases.flatMap((p) => {
  const words = p.split(' ');
  // "to do" is also written "todo" ("what do we need todo today").
  const todo = p.endsWith(' to do') ? [{ words: [...words.slice(0, -2), 'todo'], kind }] : [];
  return [{ words, kind }, ...todo];
});

/** Module-less agenda questions (agenda.md 4.7): "what's on", "what's
 * happening", "anything due", "what do I have", "what do we need to do",
 * "what is there to do", "what all to do", "what's coming up", "what's
 * overdue". AGENDA_OPENER_GAPS may stand between their words ("what do I need
 * to do", "what all do we need to do", "what is there to do"). The "I" forms
 * ask for the whole view the caller may see, as the Daily Events panel shows
 * it, never "mine". */
export const AGENDA_OPENERS: ReadonlyArray<{ words: Phrase; kind: AgendaKind }> = [
  ...opener('any', 'whats on', 'what is on', 'whats happening', 'what is happening', 'whats going on', 'what is going on',
    'whats scheduled', 'what is scheduled', 'whats due', 'what is due', 'anything due', 'anything on', 'what do have',
    'what have got', 'what do need to do', 'what do have to do', 'what have got to do', 'what is to do', 'whats to do',
    'what to do'),
  ...opener('upcoming', 'whats coming up', 'what is coming up', 'whats upcoming', 'what is upcoming', 'upcoming'),
  ...opener('overdue', 'whats overdue', 'what is overdue', 'anything overdue', 'everything overdue', 'overdue items'),
];
/** Words that may stand between an opener's words: "I" and "we" (whoever
 * asks, the answer is the whole view), "all", "else", "there". */
export const AGENDA_OPENER_GAPS: ReadonlySet<string> = new Set(['i', 'we', 'all', 'else', 'there']);
/** "my agenda", "today's agenda" ("todays" is a date), "my day", "what's on
 * my plate", "daily events". Not "my schedule" (agenda.md OQ5). */
export const AGENDA_NOUNS: ReadonlyArray<Phrase> = [['agenda'], ['my', 'agenda'], ['my', 'day'], ['my', 'plate'], ['daily', 'events']];
/** The only other words an agenda question may hold, besides one date. */
export const AGENDA_FILLERS: ReadonlySet<string> = new Set([
  'show', 'me', 'please', 'the', 'for', 'my', 'i', 'we', 'us', 'all', 'else', 'there',
]);
