import { z } from 'zod';
import { FieldKeySchema, ModuleKeySchema, QueryPlanSchema, SourceKeySchema, WriteIntentSchema } from './plan';
import { isKnownAppLink } from './routes';

/* The visual answer contract: structured blocks the staff chat draws below an
 * assistant reply. Canonical copy (Zod v3); identical copy in
 * ai/src/contracts/assistant-views.ts, Zod v4 copy in
 * frontend/src/components/chat/blocks/schema.ts. Version 1 only grows by
 * adding optional fields or new block types; a client that doesn't know a
 * block type skips it and still shows the reply text.
 *
 * Increment 1 defined the read blocks (table, KPI tiles, record detail,
 * notice, per-source group); Increment 2 adds the write review and result
 * blocks; Increment 4 the clarify block. Increment 6 adds the form block and
 * the guided-form routes. Increment 7 adds document lines and totals to the
 * form. Increment 8 adds charts, the pipeline view and agenda windows. */

export const VIEWS_VERSION = 1;
export const VIEW_CAPS = { blocks: 12, rows: 25, columns: 8, kpis: 12, string: 2000, bytes: 256 * 1024 } as const;

const text = (max: number = VIEW_CAPS.string) => z.string().max(max);

export const AppLinkSchema = z.object({
  /** App-relative only: one leading "/", never "//", no spaces. */
  path: z.string().max(300).regex(/^\/(?!\/)\S*$/),
  exact: z.boolean(),
}).strict();
export type AppLink = z.infer<typeof AppLinkSchema>;

export const SourceRefSchema = z.object({
  key: SourceKeySchema,
  label: text(80),
  module: text(120),
  moduleLabel: text(120),
  /** 'visible_to_you' when the caller's data scope is narrower than the whole company. */
  scope: z.enum(['all', 'visible_to_you']),
  scopeNote: text(200).optional(),
  branchLabel: text(120).optional(),
  freshness: z.object({
    syncStatus: z.enum(['idle', 'syncing', 'success', 'failed', 'unknown']),
    lastSyncAt: z.string().max(40).nullable(),
    moduleSyncedAt: z.string().max(40).nullable(),
  }).strict().optional(),
}).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SectionStateSchema = z.object({
  status: z.enum(['ok', 'empty', 'partial', 'no_permission', 'disabled', 'not_connected', 'never_synced', 'not_synced', 'unsupported', 'error']),
  /** Server-written text, never model prose. */
  message: text(500).optional(),
  /** Counts render as "N+". */
  lowerBound: z.boolean().optional(),
  partialReasons: z.array(z.enum(['row_cap', 'scan_limit', 'vendor_row_cap', 'vendor_field_cap', 'relation_key_cap', 'timeout', 'scope_limited', 'section_cap'])).max(8).optional(),
  retryable: z.boolean().optional(),
}).strict();
export type SectionState = z.infer<typeof SectionStateSchema>;

export const EntityRefSchema = z.object({
  module: text(120), id: text(64), number: text(80).optional(), label: text(200), source: SourceKeySchema,
}).strict();
export type EntityRef = z.infer<typeof EntityRefSchema>;

const ToneSchema = z.enum(['open', 'done', 'cancelled', 'alert', 'unknown']);
const StatusCellSchema = z.object({ t: z.literal('status'), key: text(80), label: text(120), color: text(16).optional(), tone: ToneSchema }).strict();
const NumberCellSchema = z.object({ t: z.literal('number'), v: z.number().nullable(), unit: z.enum(['minutes', 'hours', 'percent']).optional() }).strict();
/** currency null = "currency not recorded"; money is never converted or summed across currencies. */
const MoneyCellSchema = z.object({ t: z.literal('money'), v: z.number().nullable(), currency: text(8).nullable() }).strict();

export const CellSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), v: text().nullable() }).strict(),
  NumberCellSchema,
  MoneyCellSchema,
  /** Tenant-local calendar day, YYYY-MM-DD. */
  z.object({ t: z.literal('date'), v: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).strict(),
  z.object({ t: z.literal('datetime'), v: text(40).nullable(), tz: text(64) }).strict(),
  StatusCellSchema,
  z.object({ t: z.literal('bool'), v: z.boolean().nullable() }).strict(),
  z.object({ t: z.literal('ref'), label: text(200), number: text(80).optional(), href: AppLinkSchema.optional() }).strict(),
  /** PII masked on the server; never editable. */
  z.object({ t: z.literal('masked'), display: text(80) }).strict(),
]);
export type Cell = z.infer<typeof CellSchema>;

export const ColumnSchema = z.object({
  key: text(80), label: text(120),
  kind: z.enum(['text', 'number', 'money', 'date', 'datetime', 'status', 'bool', 'ref', 'masked']),
  align: z.enum(['left', 'right']),
  /** True only where the executor behind the table can sort by it. */
  sortable: z.boolean(),
  /** 1 = always shown; 2 and 3 drop out first on narrow panels. */
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
}).strict();
export type Column = z.infer<typeof ColumnSchema>;

export const RowSchema = z.object({
  key: text(80), entity: EntityRefSchema.optional(), href: AppLinkSchema.optional(), cells: z.record(z.string(), CellSchema),
}).strict();
export type Row = z.infer<typeof RowSchema>;

export const FilterChipSchema = z.object({ id: text(80), label: text(120), removable: z.boolean() }).strict();
export type FilterChip = z.infer<typeof FilterChipSchema>;

/** Lets the table re-run itself (sort, page) later without the model.
 * Carries no identity: the server re-runs it as the current caller. */
export const QueryHandleSchema = z.object({
  plan: QueryPlanSchema, section: SourceKeySchema.optional(), executor: z.enum(['L', 'Q', 'C', 'M', 'D']),
}).strict();
export type QueryHandle = z.infer<typeof QueryHandleSchema>;

export const DataTableBlockSchema = z.object({
  id: text(80),
  type: z.literal('data_table'),
  title: text(200),
  source: SourceRefSchema,
  state: SectionStateSchema,
  columns: z.array(ColumnSchema).max(VIEW_CAPS.columns),
  rows: z.array(RowSchema).max(VIEW_CAPS.rows),
  page: z.object({
    index: z.number().int().min(1), size: z.number().int().min(1).max(VIEW_CAPS.rows),
    total: z.number().int().min(0).nullable(), hasMore: z.boolean(),
  }).strict(),
  sort: z.object({ key: text(80), dir: z.enum(['asc', 'desc']) }).strict().optional(),
  filters: z.array(FilterChipSchema).max(20),
  /** One plain sentence: what the table shows ("Field Service customers you can see, newest first"). */
  interpretedAs: text(300),
  handle: QueryHandleSchema.optional(),
  listLink: AppLinkSchema.optional(),
  /** Increment 8: a today or overdue list of a Daily Events module while Daily Events is on: offer "Open Daily Events". */
  openDailyEvents: z.boolean().optional(),
}).strict();
export type DataTableBlock = z.infer<typeof DataTableBlockSchema>;

export const KpiItemSchema = z.object({
  key: text(80), label: text(120), source: SourceRefSchema, state: SectionStateSchema,
  /** null = unavailable; never shown as 0. */
  value: z.union([NumberCellSchema, MoneyCellSchema]).nullable(),
  hint: text(300).optional(), drill: QueryHandleSchema.optional(), href: AppLinkSchema.optional(),
}).strict();
export type KpiItem = z.infer<typeof KpiItemSchema>;

export const KpiGroupBlockSchema = z.object({
  id: text(80), type: z.literal('kpi_group'), title: text(200).optional(), items: z.array(KpiItemSchema).min(1).max(VIEW_CAPS.kpis),
}).strict();
export type KpiGroupBlock = z.infer<typeof KpiGroupBlockSchema>;

/* ── Guided forms (Increment 6) ── */
export const FORM_CAPS = {
  fields: 40, options: 100, multi: 10, candidates: 10, quickPicks: 3, text: 300, textarea: 4000,
  formErrors: 5, warnings: 10, notTaken: 10, sideEffects: 20, prefillKeys: 20, notices: 3,
} as const;
export const OperationIdSchema = z.string().regex(/^op_[A-Za-z0-9_-]{16,64}$/);
/** The browser's own chat session id (as POST /crm-chat sends it); the server namespaces it under the signed-in user. */
export const ClientSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const HexIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

/** A record a picker or a typed name found: its _id, the name shown, and (a "related" field) its module. */
export const FormRefValueSchema = z.object({ ref: HexIdSchema, label: text(200), module: ModuleKeySchema.optional() }).strict();
export type FormRefValue = z.infer<typeof FormRefValueSchema>;
/** Strings: text, select, date 'YYYY-MM-DD', datetime 'YYYY-MM-DDTHH:mm' (tenant wall time; 'YYYY-MM-DD'
 * while the time is missing). number, boolean, null = empty, string[] (multiselect), a record, records. */
export const FormValueSchema = z.union([
  z.string().max(FORM_CAPS.textarea), z.number(), z.boolean(), z.null(),
  z.array(z.string().max(120)).max(FORM_CAPS.options),
  FormRefValueSchema,
  z.array(FormRefValueSchema).max(FORM_CAPS.multi),
]);
export type FormValue = z.infer<typeof FormValueSchema>;
/** A record offered for picking: EntityRef plus a short line telling it apart. */
export const EntityChoiceSchema = EntityRefSchema.extend({ detail: text(200).optional() }).strict();
export type EntityChoice = z.infer<typeof EntityChoiceSchema>;

export const FormFieldSchema = z.object({
  key: FieldKeySchema,
  label: text(120),
  group: text(80).optional(),
  /** Server-written: also "hidden for your role" (D29), "Several match. Pick one.", "Times are in ...". */
  help: text(300).optional(),
  input: z.enum(['text', 'textarea', 'number', 'money', 'percent', 'date', 'datetime', 'select', 'multiselect',
    'boolean', 'record_ref', 'record_refs', 'email', 'phone']),
  required: z.boolean(),
  readOnly: z.boolean().optional(),
  /** The stored value is hidden for this role: the field starts empty; typing replaces it, empty keeps it. */
  masked: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().min(1).max(FORM_CAPS.textarea).optional(),
  currency: text(8).nullable().optional(),
  tz: text(64).optional(),
  options: z.array(z.object({ value: text(80), label: text(120), color: text(16).optional() }).strict()).max(FORM_CAPS.options).optional(),
  /** record_ref(s): searched through POST /lookup for this field; modules: a "related" field's choices; dependsOn: the parent field. */
  ref: z.object({ module: ModuleKeySchema, modules: z.array(ModuleKeySchema).min(1).max(10).optional(), dependsOn: FieldKeySchema.optional() }).strict().optional(),
  /** A typed name that matched several records: the picker opens with these, nothing chosen (L30). */
  candidates: z.array(EntityChoiceSchema).max(FORM_CAPS.candidates).optional(),
  /** One-click values ("Assign to me", "Today"). */
  quickPicks: z.array(z.object({ label: text(80), value: FormValueSchema }).strict()).max(FORM_CAPS.quickPicks).optional(),
  /** user: typed in the form; default: a default; source: the record being changed; suggested: read from the message. */
  origin: z.enum(['user', 'default', 'source', 'suggested']),
}).strict();
export type FormField = z.infer<typeof FormFieldSchema>;

const PrefillValueSchema = z.union([z.string().max(FORM_CAPS.textarea), z.number(), z.boolean(), z.null(), z.array(z.string().max(120)).max(FORM_CAPS.multi)]);
/** "Continue in full form" (work orders only, L27): the screen and a server-built prefill of the screen's own keys. */
export const FullFormActionSchema = z.object({
  kind: z.literal('full_form'), label: text(80), href: AppLinkSchema,
  prefill: z.record(FieldKeySchema, PrefillValueSchema)
    .refine((r) => Object.keys(r).length <= FORM_CAPS.prefillKeys, 'too many prefill keys')
    .refine((r) => !Object.prototype.hasOwnProperty.call(r, 'id'), 'id is never prefilled'),
}).strict();
export type FullFormAction = z.infer<typeof FullFormActionSchema>;
/** Starts a guided form or a delete review with no LLM call (the server re-checks everything). */
export const StartRecordActionSchema = z.object({
  kind: z.literal('start'), label: text(120), intent: WriteIntentSchema, disabledReason: text(200).optional(),
}).strict();

/** Four kinds: "open" a page, "ask" a question (a plan the server re-runs),
 * "start" a guided form or a delete review, and "full_form" (the work order
 * screen with a server-built prefill). */
export const RecordActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), label: text(80), href: AppLinkSchema }).strict(),
  z.object({ kind: z.literal('ask'), label: text(120), plan: QueryPlanSchema }).strict(),
  StartRecordActionSchema,
  FullFormActionSchema,
]);
export type RecordAction = z.infer<typeof RecordActionSchema>;

export const RecordDetailBlockSchema = z.object({
  id: text(80),
  type: z.literal('record_detail'),
  source: SourceRefSchema,
  state: SectionStateSchema,
  record: z.object({
    entity: EntityRefSchema, title: text(200), status: StatusCellSchema.optional(), href: AppLinkSchema.optional(), locked: z.boolean().optional(),
  }).strict(),
  sections: z.array(z.object({
    title: text(120),
    fields: z.array(z.object({ key: text(80), label: text(120), value: CellSchema }).strict()).max(40),
  }).strict()).max(8),
  lines: z.object({ columns: z.array(ColumnSchema).max(VIEW_CAPS.columns), rows: z.array(RowSchema).max(50) }).strict().optional(),
  /** Stored values only, never recomputed in the chat. */
  totals: z.array(z.object({ label: text(120), value: MoneyCellSchema }).strict()).max(10).optional(),
  related: z.array(z.object({
    label: text(120), source: SourceRefSchema, count: z.number().int().min(0).nullable(), state: SectionStateSchema, drill: QueryHandleSchema.optional(),
  }).strict()).max(10),
  /** No share, email, WhatsApp, PDF or portal actions, ever. */
  actions: z.array(RecordActionSchema).max(6),
}).strict();
export type RecordDetailBlock = z.infer<typeof RecordDetailBlockSchema>;

export const NoticeBlockSchema = z.object({
  id: text(80),
  type: z.literal('notice'),
  tone: z.enum(['info', 'warning', 'danger', 'success']),
  /** Machine-readable reason, e.g. other_sources_not_included, me_unresolved, module_refused. */
  code: text(60),
  text: text(1000),
  source: SourceRefSchema.optional(),
  href: AppLinkSchema.optional(),
}).strict();
export type NoticeBlock = z.infer<typeof NoticeBlockSchema>;

/* ── Write review (Increment 2) ───────────────────────────────────────── */

/** What else happens when a change is applied, in plain words, by kind:
 * will happen, linked record changes, deliberately not run, may happen later
 * (scheduled rules), and blocked. */
export const SideEffectSchema = z.object({
  kind: z.enum(['will', 'linked', 'not_run', 'later', 'blocked']), text: text(300),
}).strict();
export type SideEffect = z.infer<typeof SideEffectSchema>;

/* ── Document lines (Increment 7) ── */
export const LINE_CAPS = { rows: 50, qty: 100_000, qtyEdit: 999_999 } as const;
/** A row's key: "s0" or "p1" (carried from the record a document is made from), "c1" (priced by the server from
 * the request's words), "n1" (added in this form by the browser). Letters, digits and _ only, so "lines.<key>" is
 * a field key (FieldKeySchema). */
export const LineKeySchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/);

export const LineRowSchema = z.object({
  key: LineKeySchema,
  kind: z.enum(['service', 'part']),
  catalogRef: EntityRefSchema.optional(),
  name: text(200),
  /** The line's description, or "Part no. P-100". */
  detail: text(200).optional(),
  qty: z.number().int().min(1).max(LINE_CAPS.qty),
  unitPrice: MoneyCellSchema,
  /** qty x unit price, worked out by the server. */
  amount: MoneyCellSchema.optional(),
  priceFrom: z.enum(['catalog', 'source_document']),
  /** The number of the record the price came from ("DEMO01-WO-0012"). */
  from: text(80).optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
}).strict();
export type LineRow = z.infer<typeof LineRowSchema>;

/** Always computed by the server's own totals code (NC/shared/document-totals.ts), never in the chat. */
export const TotalsSchema = z.object({
  mode: z.enum(['header', 'line']), currency: text(8), subtotal: z.number(), net: z.number(), total: z.number(),
  discountPercent: z.number(), gstPercent: z.number(), rounded: z.boolean(),
  /** When the document has parts: its services and its parts before discount. */
  servicesSubtotal: z.number().optional(), partsSubtotal: z.number().optional(),
  /** The discount and the tax as amounts (line mode: the lines' together). */
  discountAmount: z.number().optional(), taxAmount: z.number().optional(),
}).strict();
export type Totals = z.infer<typeof TotalsSchema>;

/** A document form's lines (Increment 7): shown only (a source's lines), or edited from the catalog. */
export const FormLinesSchema = z.object({
  editable: z.enum(['none', 'catalog']),
  /** What Add offers; empty when editable is none or the caller can't read the catalog. */
  add: z.array(z.enum(['service', 'part'])).max(2),
  rows: z.array(LineRowSchema).max(LINE_CAPS.rows),
  /** Review needs at least one row. */
  required: z.boolean(),
  /** Rows this form may hold; Add is disabled at max. */
  max: z.number().int().min(0).max(LINE_CAPS.rows),
  /** Server-written help ("Prices come from your service catalog."). */
  help: text(300).optional(),
}).strict();
export type FormLines = z.infer<typeof FormLinesSchema>;

const OperationStatusSchema = z.enum(['pending', 'applied', 'cancelled', 'expired', 'failed', 'unknown', 'superseded']);

/** The server-built review of one staged change. Confirm sends back the
 * operation id, revision and payloadHash shown here; only that exact payload
 * can run, once, for the person who staged it. */
export const ReviewBlockSchema = z.object({
  id: text(80),
  type: z.literal('review'),
  title: text(200),
  source: SourceRefSchema,
  operation: z.object({
    id: z.string().regex(/^op_[A-Za-z0-9_-]{16,64}$/),
    revision: z.number().int().min(1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Short form of payloadHash for people ("3F9A-12C0"). */
    digest: text(24),
    expiresAt: text(40),
  }).strict(),
  module: text(120),
  op: z.enum(['create', 'update', 'delete']),
  target: EntityRefSchema.extend({ href: AppLinkSchema.optional() }).strict().optional(),
  /** Computed on the server from the stored record and the staged values. */
  changes: z.array(z.object({ key: text(80), label: text(120), before: CellSchema.nullable(), after: CellSchema.nullable() }).strict()).max(60),
  lines: z.array(LineRowSchema).max(100).optional(),
  totals: TotalsSchema.optional(),
  warnings: z.array(text(300)).max(10),
  sideEffects: z.array(SideEffectSchema).max(20),
  status: OperationStatusSchema,
  /** "Edit" takes a guided create or update back to its form. */
  editable: z.boolean().optional(),
}).strict();
export type ReviewBlock = z.infer<typeof ReviewBlockSchema>;

/** What actually happened when a change was confirmed (or why not). */
export const ResultBlockSchema = z.object({
  id: text(80),
  type: z.literal('result'),
  operationId: z.string().regex(/^op_[A-Za-z0-9_-]{16,64}$/),
  status: z.enum(['applied', 'cancelled', 'expired', 'failed', 'unknown', 'superseded']),
  module: text(120),
  op: z.enum(['create', 'update', 'delete']),
  record: z.object({ entity: EntityRefSchema, title: text(200), status: StatusCellSchema.optional(), href: AppLinkSchema.optional() }).strict().optional(),
  /** Server-written, e.g. "Created work order 9A218C-WO-0009." or "Already applied: 9A218C-WO-0009". */
  message: text(500),
  next: z.array(RecordActionSchema).max(4),
}).strict();
export type ResultBlock = z.infer<typeof ResultBlockSchema>;

/** A guided create or update (Increment 6): the fields, the values so far
 * and what still keeps Review from being pressed. The browser edits it
 * through the guided-form routes below; Review turns it into a ReviewBlock. */
export const FormBlockSchema = z.object({
  id: text(80), type: z.literal('form'), title: text(200), source: SourceRefSchema,
  operation: z.object({ id: OperationIdSchema, revision: z.number().int().min(1), expiresAt: text(40) }).strict(),
  module: text(120),
  op: z.enum(['create', 'update']),            // a delete goes straight to a review (L10)
  target: EntityRefSchema.extend({ href: AppLinkSchema.optional() }).strict().optional(),
  /** Tenant IANA zone of every datetime value (L17). */
  timezone: text(64),
  fields: z.array(FormFieldSchema).min(1).max(FORM_CAPS.fields),
  values: z.record(FieldKeySchema, FormValueSchema).refine((r) => Object.keys(r).length <= FORM_CAPS.fields, 'too many values'),
  /** By a field's key, 'lines' (the list) or 'lines.<key>' (a row). */
  errors: z.record(FieldKeySchema, text(300)).refine((r) => Object.keys(r).length <= FORM_CAPS.fields + LINE_CAPS.rows + 1, 'too many errors'),
  formErrors: z.array(text(300)).max(FORM_CAPS.formErrors),
  warnings: z.array(text(300)).max(FORM_CAPS.warnings),
  /** Words of the request the assistant did not use (L3). */
  notTaken: z.array(text(120)).max(FORM_CAPS.notTaken),
  sideEffects: z.array(SideEffectSchema).max(FORM_CAPS.sideEffects),
  /** Increment 7: a document's lines and its totals (null: not worked out yet). */
  lines: FormLinesSchema.optional(), totals: TotalsSchema.nullable().optional(),
  /** No field error, no missing required value, no form error: Review may be pressed. */
  ready: z.boolean(),
  fullForm: FullFormActionSchema.optional(),
}).strict();
export type FormBlock = z.infer<typeof FormBlockSchema>;

/* ── Clarify (Increment 4) ────────────────────────────────────────────────
 * A question back, with up to ten choices, when the assistant can't answer
 * as asked: the wording is ambiguous or too long, the planner is busy or
 * unavailable, its answer couldn't be used, or the change needs the classic
 * assistant. Each choice says exactly what it runs: a plan (re-run by the
 * server as the caller, like a table's handle), a write intent (the guided
 * forms, Increment 6), a message sent as if typed, or a message handed to
 * the classic assistant. The question and choices are server-written, or
 * the planner's own question, checked and cut to size. */

export const CLARIFY_REASONS = [
  'ambiguous_entity', 'ambiguous_module', 'ambiguous_source', 'missing_value', 'no_focus', 'unsupported',
  'not_understood', 'planner_unavailable', 'planner_busy', 'too_long', 'needs_classic', 'duplicate_number',
] as const;

export const ClarifyOptionSchema = z.object({
  label: z.string().min(1).max(120),
  detail: text(200).optional(),
  source: SourceRefSchema.optional(),
  run: z.union([
    z.object({ plan: QueryPlanSchema }).strict(),
    z.object({ intent: WriteIntentSchema }).strict(),
    z.object({ message: z.string().min(1).max(4000) }).strict(),
    z.object({ legacy: z.object({ message: z.string().min(1).max(4000) }).strict() }).strict(),
  ]),
}).strict();
export type ClarifyOption = z.infer<typeof ClarifyOptionSchema>;

export const ClarifyBlockSchema = z.object({
  id: text(80),
  type: z.literal('clarify'),
  question: z.string().min(1).max(300),
  reason: z.enum(CLARIFY_REASONS),
  options: z.array(ClarifyOptionSchema).max(10),
}).strict();
export type ClarifyBlock = z.infer<typeof ClarifyBlockSchema>;

/* ── Charts, pipeline and agenda (Increment 8) ──────────────────────────
 * Three read-only blocks, top level only. A chart draws one measure (a
 * count, or money in one currency) per category or date bucket, one series
 * per source, never stacked or added across sources or currencies; its
 * numbers also travel as a table (its text alternative and "View as table").
 * A pipeline counts one module's records per stage of the tenant's own
 * pipeline. An agenda lists what is due or scheduled in a window, one group
 * per module of one source, with exact totals ("Showing 5 of 42"). Nothing
 * here links outside the route table: an item the table has no page for
 * carries no link. */
export const CHART_CAPS = { categories: 50, series: 3, actions: 3 } as const;
export const PIPELINE_CAPS = { stages: 30, amounts: 6 } as const;
// items equals the composers' budget (query/agenda.ts AGENDA_ITEMS_PER_BLOCK); with 3 parts a group the
// block stays well under VIEW_CAPS.bytes at every cap (Increment 8 spec check integration-3).
export const AGENDA_CAPS = { groups: 30, itemsPerBucket: 15, items: 80 } as const;

/** A tenant colour as the app stores it ("#6366f1"); anything else is left out, never sent. */
const HexColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 24-hour tenant-local wall time, HH:mm. */
const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** A question a block offers as a chip ("By created date"): a plan the server
 * re-runs as the caller (a run_plan action, no LLM call). */
export const AskActionSchema = z.object({ kind: z.literal('ask'), label: text(120), plan: QueryPlanSchema }).strict();
export type AskAction = z.infer<typeof AskActionSchema>;

/** One bar or point. x: its category's key, the same in every series (a date
 * bucket's first day YYYY-MM-DD, a stage key, a customer number, "__none");
 * label: how it is shown ("Mar 2026", "ABC Industries"); y null: not
 * available, never drawn as 0 (finite: Zod 3 would pass Infinity, which JSON
 * turns into null and Zod 4 refuses); drill: not sent in Increment 8. */
export const ChartPointSchema = z.object({
  x: text(80), label: text(120), y: z.number().finite().nullable(), drill: QueryHandleSchema.optional(),
}).strict();
export type ChartPoint = z.infer<typeof ChartPointSchema>;

export const ChartSeriesSchema = z.object({
  key: text(80), label: text(120), source: SourceRefSchema,
  points: z.array(ChartPointSchema).max(CHART_CAPS.categories)
    .refine((points) => new Set(points.map((p) => p.x)).size === points.length, 'a category twice in one series'),
}).strict();
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

/** The chart's numbers as a table: one row per point (row key = point x), all
 * on one page, never re-run (no handle). */
export const ChartTableSchema = DataTableBlockSchema.omit({ handle: true }).extend({
  rows: z.array(RowSchema).max(CHART_CAPS.categories),
  page: z.object({
    index: z.literal(1), size: z.number().int().min(1).max(CHART_CAPS.categories),
    total: z.number().int().min(0).nullable(), hasMore: z.boolean(),
  }).strict(),
}).strict();
export type ChartTable = z.infer<typeof ChartTableSchema>;

export const ChartBlockSchema = z.object({
  id: text(80),
  type: z.literal('chart'),
  title: text(200),
  /** bar: upright bars; hbar: horizontal bars (rankings, many or long names); line: over time. */
  kind: z.enum(['bar', 'hbar', 'line']),
  state: SectionStateSchema,
  x: z.object({ label: text(120), kind: z.enum(['category', 'day', 'week', 'month', 'quarter', 'year']) }).strict(),
  /** One measure per chart; money in one currency (null: "currency not recorded"). */
  y: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('count'), label: text(120) }).strict(),
    z.object({ kind: z.literal('money'), label: text(120), currency: text(8).nullable() }).strict(),
  ]),
  /** One series per source; never stacked, never added together. */
  series: z.array(ChartSeriesSchema).min(1).max(CHART_CAPS.series)
    .refine((series) => new Set(series.flatMap((s) => s.points.map((p) => p.x))).size <= CHART_CAPS.categories, 'over the category cap'),
  /** Server-written: what is counted or added up, by which date, and the cancelled rule. */
  basis: text(500),
  /** Server-written text alternative. */
  summary: text(500),
  table: ChartTableSchema,
  actions: z.array(AskActionSchema).max(CHART_CAPS.actions).optional(),
}).strict();
export type ChartBlock = z.infer<typeof ChartBlockSchema>;

/** One currency's sum; never added to another currency's. */
const StageAmountSchema = z.object({ v: z.number().finite(), currency: z.string().min(1).max(8) }).strict();

export const PipelineStageSchema = z.object({
  key: text(80), label: text(120), color: HexColorSchema.optional(),
  /** The tenant's own order (0, 1, 2, ...). */
  order: z.number().int().min(0),
  terminal: z.boolean(),
  /** The stage's tagged outcome, or 'cancelled' for a stage in the cancelled set. */
  outcome: text(40).optional(),
  count: z.number().int().min(0),
  /** Money in the stage, one entry per currency; absent: none, or a module with no amount. */
  amounts: z.array(StageAmountSchema).min(1).max(PIPELINE_CAPS.amounts).optional(),
  drill: QueryHandleSchema.optional(),
}).strict();
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PipelineBlockSchema = z.object({
  id: text(80),
  type: z.literal('pipeline'),
  title: text(200),
  source: SourceRefSchema,
  state: SectionStateSchema,
  /** Display only: a pipeline has no handle, so no chip can be removed. */
  filters: z.array(FilterChipSchema).max(20),
  interpretedAs: text(300),
  stages: z.array(PipelineStageSchema).max(PIPELINE_CAPS.stages),
  /** What the amounts are ("Amount", "Expected revenue", "Total"); absent: counts only. */
  amountLabel: text(60).optional(),
  /** Records not in any listed stage: a removed stage, a key no longer in the pipeline, or none. */
  offPipeline: z.object({ count: z.number().int().min(1), note: text(300), drill: QueryHandleSchema.optional() }).strict().optional(),
  listLink: AppLinkSchema.optional(),
}).strict();
export type PipelineBlock = z.infer<typeof PipelineBlockSchema>;

export const AgendaItemSchema = z.object({
  /** Unique in the block, Daily Events' id format ("<source>:<module>:<record id>[:<n>]"); never shown. */
  key: text(200),
  title: text(200),
  /** What the date means for this record: "Due", "Starts", "SLA breached", "Was due". */
  kind: text(60),
  /** The item's tenant-local calendar day. */
  date: DayKeySchema,
  /** Tenant-local start and end time; absent for an all-day (date-only) item. */
  time: ClockTimeSchema.optional(),
  endTime: ClockTimeSchema.optional(),
  allDay: z.boolean(),
  status: StatusCellSchema.optional(),
  subtitle: text(160).optional(),
  /** The record it is about ("ABC Industries"): a name only, never a link. */
  related: text(120).optional(),
  assignee: text(120).optional(),
  /** A task, call, meeting or activity about a lead. */
  leadFollowUp: z.boolean().optional(),
  /** Overdue items: whole days past their date. */
  daysLate: z.number().int().min(1).optional(),
  /** A page in the route table only; a connector item has none (Increment 8). */
  href: AppLinkSchema.optional(),
}).strict();
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const AgendaBucketSchema = z.object({
  bucket: z.enum(['overdue', 'today', 'upcoming', 'window']),
  /** Server title for a window part ("Rest of this week"); absent: the client's own bucket title. */
  label: text(120).optional(),
  items: z.array(AgendaItemSchema).max(AGENDA_CAPS.itemsPerBucket),
  /** Exact count of the bucket; null when it couldn't be read (never 0 then). */
  total: z.number().int().min(0).nullable(),
  /** total is "at least" (a scan limit was hit). */
  lowerBound: z.boolean(),
  /** The bucket in full, as a list the server re-runs (executor Q, run_plan). */
  drill: QueryHandleSchema.optional(),
}).strict();
export type AgendaBucket = z.infer<typeof AgendaBucketSchema>;

export const AgendaGroupSchema = z.object({
  /** One module of one source; groups are never merged across sources. */
  source: SourceRefSchema,
  state: SectionStateSchema,
  /** At most 3 parts: overdue, today, then upcoming or the window. */
  buckets: z.array(AgendaBucketSchema).max(3),
}).strict();
export type AgendaGroup = z.infer<typeof AgendaGroupSchema>;

export const AgendaBlockSchema = z.object({
  id: text(80),
  type: z.literal('agenda'),
  title: text(200),
  /** Today in the tenant's timezone. */
  date: DayKeySchema,
  /** The days covered, both ends included (null: open-ended, e.g. overdue), and how to say them. */
  window: z.object({ from: DayKeySchema.nullable(), to: DayKeySchema.nullable(), label: text(120) }).strict(),
  timezone: text(64),
  interpretedAs: text(300),
  groups: z.array(AgendaGroupSchema).max(AGENDA_CAPS.groups)
    .refine((groups) => groups.reduce((n, g) => n + g.buckets.reduce((m, b) => m + b.items.length, 0), 0) <= AGENDA_CAPS.items, 'too many items'),
  /** True only when Daily Events itself answered (today, overdue, next 7 days, the whole view). */
  openDailyEvents: z.boolean(),
}).strict();
export type AgendaBlock = z.infer<typeof AgendaBlockSchema>;

const InnerBlockSchema = z.discriminatedUnion('type', [DataTableBlockSchema, KpiGroupBlockSchema, RecordDetailBlockSchema, NoticeBlockSchema]);

/** One section per source, each with its own state. Deliberately no total
 * field: numbers from different sources are never added together. */
export const SourceGroupBlockSchema = z.object({
  id: text(80),
  type: z.literal('source_group'),
  title: text(200),
  sections: z.array(z.object({
    source: SourceRefSchema, state: SectionStateSchema, blocks: z.array(InnerBlockSchema).max(VIEW_CAPS.blocks),
  }).strict()).min(1).max(8),
}).strict();
export type SourceGroupBlock = z.infer<typeof SourceGroupBlockSchema>;

/** Written out rather than inferred (Increment 8): with the chart, pipeline
 * and agenda blocks the inferred union is too long for the compiler to emit
 * in declaration files (TS7056). Same members as the schema below. */
export type ViewBlock = DataTableBlock | KpiGroupBlock | RecordDetailBlock | NoticeBlock | SourceGroupBlock
  | ReviewBlock | ResultBlock | ClarifyBlock | FormBlock | ChartBlock | PipelineBlock | AgendaBlock;
export const ViewBlockSchema: z.ZodType<ViewBlock> = z.discriminatedUnion('type', [
  DataTableBlockSchema, KpiGroupBlockSchema, RecordDetailBlockSchema, NoticeBlockSchema, SourceGroupBlockSchema,
  ReviewBlockSchema, ResultBlockSchema, ClarifyBlockSchema, FormBlockSchema, ChartBlockSchema, PipelineBlockSchema, AgendaBlockSchema,
]);

/* ── View actions (Increment 3) ────────────────────────────────────────────
 * POST /api/v1/ai/crm-assist/view: the browser re-runs a table's handle to
 * sort it, page it or drop one of its filter chips. No AI service hop and
 * no model call. The handle carries no identity: the server re-validates
 * the plan and re-runs it as the current caller, on the handle's own
 * executor (an L handle is never re-run on Q). */

export const ViewActionRequestSchema = z.object({
  handle: QueryHandleSchema,
  page: z.number().int().min(1).max(1000).optional(),
  sort: z.object({
    key: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/),
    dir: z.enum(['asc', 'desc']),
  }).strict().optional(),
  /** The id of one of the table's filter chips (server-made: "w0" … "w9", "search"). */
  removeFilter: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/).optional(),
}).strict();
export type ViewActionRequest = z.infer<typeof ViewActionRequestSchema>;

/** The re-run table, plus notices for any part of the request that could not
 * be honoured ("Sorting isn't available while searching Leads by text"). */
export const ViewActionResultSchema = z.object({
  block: DataTableBlockSchema,
  notices: z.array(NoticeBlockSchema).max(3),
}).strict();
export type ViewActionResult = z.infer<typeof ViewActionResultSchema>;

/* ── Guided-form routes (browser, POST, Increment 6) ── */
export const OperationConfirmationSchema = z.object({
  operationId: OperationIdSchema, revision: z.number().int().min(1), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: text(40), summary: text(500),
}).strict();
export type OperationConfirmation = z.infer<typeof OperationConfirmationSchema>;
/** A line as the browser sends it: the whole list, only when it changed. A row is kept by its key, removed by
 * leaving it out, and added with the catalog record picked (ref, only on a new key). Never a name, a price, a tax
 * or a total. */
export const LineEditSchema = z.object({
  key: LineKeySchema, kind: z.enum(['service', 'part']),
  ref: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  qty: z.number().int().min(1).max(LINE_CAPS.qtyEdit),
}).strict();
export type LineEdit = z.infer<typeof LineEditSchema>;
export const FormValidateRequestSchema = z.object({
  sessionId: ClientSessionIdSchema, revision: z.number().int().min(1),
  /** Only the fields changed since the block the browser shows. */
  values: z.record(FieldKeySchema, FormValueSchema).refine((r) => Object.keys(r).length <= FORM_CAPS.fields, 'too many values'),
  /** Increment 7: a document's whole line list, when it changed. */
  lines: z.array(LineEditSchema).max(LINE_CAPS.rows).optional(),
}).strict();
export const FormRevisionRequestSchema = z.object({ sessionId: ClientSessionIdSchema, revision: z.number().int().min(1) }).strict();
export const FormSessionRequestSchema = z.object({ sessionId: ClientSessionIdSchema }).strict();
export const FormActionResultSchema = z.object({
  block: z.discriminatedUnion('type', [FormBlockSchema, ReviewBlockSchema, ResultBlockSchema]),
  notices: z.array(NoticeBlockSchema).max(FORM_CAPS.notices),
  confirmation: OperationConfirmationSchema.optional(),
}).strict();
export type FormActionResult = z.infer<typeof FormActionResultSchema>;
export const LookupRequestSchema = z.object({
  sessionId: ClientSessionIdSchema, operationId: OperationIdSchema, field: FieldKeySchema,
  q: z.string().max(100), module: ModuleKeySchema.optional(),
}).strict();
export const LookupResultSchema = z.object({
  items: z.array(EntityChoiceSchema).max(10), more: z.boolean(), state: SectionStateSchema,
}).strict();
export type LookupResult = z.infer<typeof LookupResultSchema>;

/** Written out rather than inferred: the inferred type is too long for the
 * compiler to emit in declaration files. */
export interface ViewsEnvelope { v: typeof VIEWS_VERSION; turnId: string; blocks: ViewBlock[] }
export const ViewsEnvelopeSchema: z.ZodType<ViewsEnvelope> = z.object({
  v: z.literal(VIEWS_VERSION),
  turnId: text(64),
  blocks: z.array(ViewBlockSchema).max(VIEW_CAPS.blocks),
}).strict();

export const ReplyMetaSchema = z.object({
  path: z.enum(['grammar', 'planner', 'workflow', 'action', 'clarify', 'legacy']),
  llmCalls: z.number().int().min(0),
  engine: z.enum(['off', 'shadow', 'on']),
  interpretedAs: text(300).optional(),
}).strict();
export type ReplyMeta = z.infer<typeof ReplyMetaSchema>;

/** Every app link inside a value (any depth), for the route-template check. */
export function collectLinks(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectLinks(v, out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.path === 'string' && typeof o.exact === 'boolean') out.push(o.path);
    for (const v of Object.values(o)) collectLinks(v, out);
  }
  return out;
}

/** Fails closed: a block that is invalid, too big or links outside the app's
 * known routes is dropped and reported; the rest of the reply stays. */
export function validateViews(input: unknown): { views: ViewsEnvelope | null; dropped: string[] } {
  const dropped: string[] = [];
  const base = z.object({ v: z.literal(VIEWS_VERSION), turnId: text(64), blocks: z.array(z.unknown()) }).strict().safeParse(input);
  if (!base.success) return { views: null, dropped: ['envelope'] };
  const blocks: ViewBlock[] = [];
  for (const [i, raw] of base.data.blocks.entries()) {
    if (blocks.length >= VIEW_CAPS.blocks) { dropped.push(`block ${i}: over the block cap`); continue; }
    const parsed = ViewBlockSchema.safeParse(raw);
    if (!parsed.success) { dropped.push(`block ${i}: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? 'invalid'}`); continue; }
    const badLink = collectLinks(parsed.data).find((p) => !isKnownAppLink(p));
    if (badLink) { dropped.push(`block ${i}: unknown link ${badLink}`); continue; }
    blocks.push(parsed.data);
  }
  const views: ViewsEnvelope = { v: VIEWS_VERSION, turnId: base.data.turnId, blocks };
  if (Buffer.byteLength(JSON.stringify(views)) > VIEW_CAPS.bytes) return { views: null, dropped: [...dropped, 'envelope: over the size cap'] };
  return { views, dropped };
}
