import { z } from 'zod';

/* The question as the assistant understood it — a QueryPlan — plus the small
 * session state the AI service keeps between turns, and (Increment 4) the
 * write intent, the planner's output and the catalog the planner is given.
 * Canonical copy (Zod v3);
 * ai/src/contracts/assistant-views.ts holds an identical Zod v3 copy and
 * frontend/src/components/chat/blocks/schema.ts a Zod v4 copy. Change all
 * three together and refresh the fixture manifests
 * (npm run verify:crm-assist-contract -- --write).
 *
 * A plan never carries identity: there is no tenant, user, branch, role or
 * scope key anywhere, and every object is .strict(), so such keys are
 * rejected rather than ignored. */

export const SOURCE_KEYS = [
  'native_crm', 'field_service', 'custom_module', 'connector:zoho', 'connector:salesforce', 'connector:hubspot',
] as const;
export const SourceKeySchema = z.enum(SOURCE_KEYS);
export type SourceKey = z.infer<typeof SourceKeySchema>;

export const REL_RANGES = [
  'today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'next_week', 'this_month', 'last_month', 'next_month',
  'this_quarter', 'last_quarter', 'this_year', 'last_year', 'last_7_days', 'next_7_days', 'last_30_days', 'next_30_days',
] as const;
export const RelRangeSchema = z.enum(REL_RANGES);
export type RelRange = z.infer<typeof RelRangeSchema>;

export const DateExprSchema = z.union([
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ rel: RelRangeSchema, edge: z.enum(['start', 'end']) }).strict(),
]);
export type DateExpr = z.infer<typeof DateExprSchema>;

export const ScalarSchema = z.union([z.string().max(200), z.number(), z.boolean()]);
/** A field key: no "$", at most one dot ("customFields.region", "data.amount"). */
export const FieldKeySchema = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/);
/** A module key: "invoice", "custom:site_visits", "connector:zoho:Deals". */
export const ModuleKeySchema = z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*(:[A-Za-z0-9_ -]+){0,2}$/);
const NumOrDate = z.union([z.number(), DateExprSchema]);

export const CondSchema = z.union([
  z.object({ f: FieldKeySchema, op: z.enum(['eq', 'ne']), v: ScalarSchema }).strict(),
  z.object({ f: FieldKeySchema, op: z.enum(['in', 'nin']), v: z.array(ScalarSchema).max(50) }).strict(),
  z.object({ f: FieldKeySchema, op: z.enum(['gt', 'gte', 'lt', 'lte']), v: NumOrDate }).strict(),
  z.object({ f: FieldKeySchema, op: z.literal('between'), v: z.tuple([NumOrDate, NumOrDate]) }).strict(),
  z.object({ f: FieldKeySchema, op: z.literal('within'), v: RelRangeSchema }).strict(),
  z.object({ f: FieldKeySchema, op: z.literal('contains'), v: z.string().max(100) }).strict(),
  z.object({ f: FieldKeySchema, op: z.enum(['empty', 'not_empty']) }).strict(),
  z.object({ op: z.literal('state'), v: z.enum(['open', 'closed', 'overdue', 'due_today', 'expiring']), range: RelRangeSchema.optional() }).strict(),
  z.object({ op: z.literal('outcome'), v: z.string().max(40), not: z.boolean().optional() }).strict(),
]);
export type Cond = z.infer<typeof CondSchema>;

const RefSchema = z.string().min(1).max(160);

export const QueryPlanSchema = z.object({
  v: z.literal(1),
  op: z.enum(['list', 'count', 'aggregate', 'detail', 'agenda']),
  target: z.union([
    z.object({ module: ModuleKeySchema }).strict(),
    /** 'agenda' (Increment 8, op 'agenda' only): every Daily Events module the caller may read. */
    z.object({ concept: z.enum(['customer', 'deal', 'contact', 'task', 'meeting', 'agenda']), sources: z.array(SourceKeySchema).max(6).optional() }).strict(),
  ]),
  where: z.array(CondSchema).max(10).optional(),
  mine: z.enum(['assigned', 'created']).optional(),
  /** Search text, escaped exactly once by the executor (never here). */
  search: z.string().max(100).optional(),
  relation: z.union([
    z.object({ kind: z.enum(['has', 'has_none']), name: z.string().max(60), where: z.array(CondSchema).max(5).optional() }).strict(),
    z.object({
      kind: z.literal('for'), name: z.string().max(60),
      entity: z.union([
        z.object({ text: z.string().max(100) }).strict(),
        z.object({ ref: RefSchema }).strict(),
        z.object({ focus: z.literal(true) }).strict(),
      ]),
    }).strict(),
  ]).optional(),
  group: z.object({ by: FieldKeySchema, bucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional() }).strict().optional(),
  metrics: z.array(z.union([
    z.object({ fn: z.literal('count') }).strict(),
    z.object({ fn: z.enum(['sum', 'avg', 'min', 'max']), field: FieldKeySchema }).strict(),
    z.object({ metric: z.string().max(60) }).strict(),
  ])).max(5).optional(),
  sort: z.object({ by: FieldKeySchema, dir: z.enum(['asc', 'desc']) }).strict().optional(),
  top: z.number().int().min(1).max(50).optional(),
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(25).optional(),
  record: z.union([
    z.object({ ref: RefSchema }).strict(),
    z.object({ number: z.string().max(80) }).strict(),
    z.object({ focus: z.literal(true) }).strict(),
  ]).optional(),
  window: z.union([RelRangeSchema, z.object({ from: DateExprSchema, to: DateExprSchema }).strict()]).optional(),
  present: z.enum(['auto', 'table', 'kpi', 'bar', 'hbar', 'line', 'pipeline']).optional(),
}).strict();
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/* ── Write intents and the planner (Increment 4) ──────────────────────── */

/** At most this many keys in a write intent's refs or values, or in a fill. */
const MAX_INTENT_KEYS = 30;
const withinKeys = (min: number) => (r: Record<string, unknown>): boolean => {
  const n = Object.keys(r).length;
  return n >= min && n <= MAX_INTENT_KEYS;
};
/** Keys a write intent or a fill never sets: who owns or may see a record
 * and what the system keeps on it. The server sets them itself, so one of
 * them in a planner output makes the whole output invalid. */
const RESERVED_VALUE_KEYS: ReadonlySet<string> = new Set([
  'tenantId', 'branchId', 'userId', 'createdBy', 'updatedBy', 'ownerId', 'role', 'roleId', 'scope', 'id',
  'isDeleted', 'deletedAt', 'createdAt', 'updatedAt',
]);
const noReservedKeys = (r: Record<string, unknown>): boolean => Object.keys(r).every((key) => !RESERVED_VALUE_KEYS.has(key));
export function isReservedValueKey(key: string): boolean { return RESERVED_VALUE_KEYS.has(key); }

const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** A tenant-local wall time for a write value (never a query): "tomorrow at 3pm"
 * -> { date: '2026-11-01', time: '15:00' }. The server converts it to an instant
 * in the tenant's timezone (grammar/wall-time.ts). */
export const DateTimeExprSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: ClockSchema }).strict();
export type DateTimeExpr = z.infer<typeof DateTimeExprSchema>;
export const WriteValueSchema = z.union([ScalarSchema, DateExprSchema, DateTimeExprSchema]);
export type WriteValue = z.infer<typeof WriteValueSchema>;

/** How a write names a record: typed text, a server-written _id (a clarify
 * option, a record action, a picker), the record on screen, or "me". */
export const RefInputSchema = z.union([
  z.object({ text: z.string().max(100) }).strict(),
  z.object({ ref: z.string().regex(/^[a-f0-9]{24}$/i), module: ModuleKeySchema.optional() }).strict(),
  z.object({ focus: z.literal(true) }).strict(),
  z.object({ me: z.literal(true) }).strict(),
]);
export type RefInput = z.infer<typeof RefInputSchema>;

/** A change someone asked for, in their own words: the module, the record
 * named by its number, its text or the record on screen, and values taken
 * from the message. Never an id the assistant made up, a price, a tax or a
 * total. The guided forms (Increment 6) start from it; a write the forms
 * don't take is handed to the existing assistant. */
export const WriteIntentSchema = z.object({
  v: z.literal(1),
  op: z.enum(['create', 'update', 'delete']),
  module: ModuleKeySchema,
  target: z.union([
    z.object({ ref: RefSchema }).strict(),
    z.object({ number: z.string().max(80) }).strict(),
    z.object({ text: z.string().max(100) }).strict(),
    z.object({ focus: z.literal(true) }).strict(),
  ]).optional(),
  from: z.union([
    z.object({ module: ModuleKeySchema, ref: RefSchema }).strict(),
    z.object({ module: ModuleKeySchema, number: z.string().max(80) }).strict(),
    z.object({ focus: z.literal(true) }).strict(),
  ]).optional(),
  /** Records named by field: { customerId: { text: 'ABC Industries' } }; a list (staffIds) names several. */
  refs: z.record(FieldKeySchema, z.union([RefInputSchema, z.array(RefInputSchema).min(1).max(10)]))
    .refine(withinKeys(0), 'too many references').refine(noReservedKeys, 'a reserved key').optional(),
  values: z.record(FieldKeySchema, WriteValueSchema)
    .refine(withinKeys(0), 'too many values').refine(noReservedKeys, 'a reserved key').optional(),
  /** Catalog lines named in words; priced on the server. */
  lines: z.array(z.object({
    catalog: z.enum(['service', 'part']), text: z.string().max(100), qty: z.number().positive().max(100000).optional(),
  }).strict()).max(20).optional(),
}).strict();
export type WriteIntent = z.infer<typeof WriteIntentSchema>;

/** What the planner (the one LLM call for wording the grammar can't read)
 * hands back, checked strictly on the server before anything runs: a query
 * plan, a write intent, values for the open form (bound on the server to
 * the session's own draft operation, never by an id in the output), a
 * question back, or "not about this CRM". */
export const PlannerOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query'), plan: QueryPlanSchema }).strict(),
  z.object({ kind: z.literal('write'), intent: WriteIntentSchema }).strict(),
  z.object({
    kind: z.literal('fill'),
    values: z.record(FieldKeySchema, WriteValueSchema)
      .refine(withinKeys(0), 'too many values').refine(noReservedKeys, 'a reserved key'),
    /** Records named in words for the form's reference fields; the server looks them up under the caller's scope. */
    refs: z.record(FieldKeySchema, z.object({ text: z.string().max(100) }).strict())
      .refine(withinKeys(0), 'too many references').refine(noReservedKeys, 'a reserved key').optional(),
  }).strict(),
  z.object({
    kind: z.literal('clarify'),
    question: z.string().min(1).max(200),
    options: z.array(z.string().min(1).max(80)).max(5).optional(),
  }).strict(),
  z.object({ kind: z.literal('out_of_scope'), reason: z.string().max(200) }).strict(),
]);
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/** Size limits of the planner's one request (plan 1.4 and 4.10). A message
 * longer than the planner reads gets a "too long" clarify instead (no LLM
 * call); a verify script checks the worst case of the whole request. */
export const PLANNER_CAPS = {
  messageChars: 1200,
  messageEstTokens: 600,
  catalogChars: 1500,
  catalogEstTokens: 450,
  lastPlanChars: 600,
  lastPlanEstTokens: 200,
  requestChars: 9000,
  requestEstTokens: 2500,
} as const;

/** The plan's token estimate (1.4): ASCII characters divided by 4, plus one
 * for every other character (code point). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export const PLANNER_SOURCES = ['fs', 'crm', 'cm', 'zoho', 'sf', 'hs'] as const;
/** n number, m money, d date, s text, e choice (enum or stage), b yes/no, r reference. */
export const PLANNER_FIELD_KINDS = ['n', 'm', 'd', 's', 'e', 'b', 'r'] as const;

/** What the planner is told about the caller's CRM, built by the server
 * from the modules this caller may read: today's date, the timezone and
 * currency, up to 12 modules ranked by the words of the message ("more"
 * counts the rest), and for up to 3 of them the fields, stages and outcomes
 * a plan may use. Within PLANNER_CAPS (catalogChars, catalogEstTokens). */
export const PlannerCatalogSchema = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().min(1).max(64),
  currency: z.string().max(8).nullable(),
  modules: z.array(z.tuple([ModuleKeySchema, z.string().min(1).max(80), z.enum(PLANNER_SOURCES)])).max(12),
  more: z.number().int().min(0).max(10000),
  /** The module of the form open in this chat, whose detail entry lists that form's fields. */
  form: ModuleKeySchema.optional(),
  detail: z.array(z.object({
    m: ModuleKeySchema,
    f: z.array(z.tuple([FieldKeySchema, z.enum(PLANNER_FIELD_KINDS), z.string().min(1).max(80)])).max(30),
    stages: z.array(z.string().min(1).max(80)).max(20).optional(),
    outcomes: z.array(z.string().min(1).max(40)).max(10).optional(),
    rel: z.array(z.string().min(1).max(60)).max(10).optional(),
    metrics: z.array(z.string().min(1).max(60)).max(10).optional(),
  }).strict()).max(3),
}).strict().refine((c) => {
  const text = JSON.stringify(c);
  return text.length <= PLANNER_CAPS.catalogChars && estimateTokens(text) <= PLANNER_CAPS.catalogEstTokens;
}, 'over the catalog size cap');
export type PlannerCatalog = z.infer<typeof PlannerCatalogSchema>;

/** Kept by the AI service next to the conversation history: a hint for the
 * next turn, never authority (the backend re-checks every part of it). */
export const AssistSessionStateSchema = z.object({
  v: z.literal(1),
  lastPlan: QueryPlanSchema.optional(),
  focus: z.object({ module: ModuleKeySchema, id: z.string().regex(/^[a-f0-9]{24}$/i), at: z.string().max(40) }).strict().optional(),
  operationId: z.string().max(100).optional(),
}).strict();
export type AssistSessionState = z.infer<typeof AssistSessionStateSchema>;

/** What the browser may say about where the user is. A hint only: the
 * backend re-fetches any focus record under the caller's own scope. */
export const ClientContextSchema = z.object({
  route: z.string().max(200).optional(),
  focus: z.object({ module: ModuleKeySchema, id: z.string().regex(/^[a-f0-9]{24}$/i) }).strict().optional(),
  operationId: z.string().max(100).optional(),
}).strict();
export type ClientContext = z.infer<typeof ClientContextSchema>;
