import type { DataScope } from '../../../types';
import type { CrmWriteModuleDef } from '../../internal/crm-write.module-map';
import type { CustomFieldType } from '../../native-crm/custom-fields/custom-field.model';
import type { AssistIdentity } from '../identity';
import type { GatewayTenant } from '../gates';
import type { RelatedGate } from '../query/relations';
import type { ModuleCap, WriteCap, WriteFieldKind, WriteFormField, WriteOp } from '../registry/types';
import type { RefInput, WriteIntent, WriteValue } from '../contracts/plan';
import type {
  AppLink, EntityChoice, EntityRef, FormBlock, FormField, FormLines, FormValue, LineEdit, LineRow, NoticeBlock, OperationConfirmation,
  ResultBlock, ReviewBlock, SideEffect, Totals,
} from '../contracts/views';
import type { ComposedAnswer } from '../views/compose';
import type { FieldChange } from '../operations/diff';
import type { DocumentTotals } from '../../native-crm/shared/document-totals';
import type { WorkflowSealed } from '../operations/sealed';

/* The types the guided forms (Increment 6) share across the write grammar,
 * references, prefill, the validation stack, the lifecycle and the views:
 * what a form knows about its caller (FormContext), how a reference is stored
 * (StoredRef), what each layer takes and gives, and the one reply type every
 * lifecycle step answers with (WorkflowReply). Increment 7 adds a document's
 * lines, the record a create is made from and the confirm hooks. Types only;
 * nothing runs. */

export type FormOrigin = FormField['origin'];
export type StartSource = 'grammar' | 'planner' | 'action';
/** source_document (Increment 7): a value copied from the record a create is made from. */
export type PrefillSource = 'fs_defaults' | 'stage_default' | 'model_default' | 'branch_currency' | 'own_staff' | 'customer_address' | 'site_address'
  | 'source_document';
/** Why a value read from words couldn't be used as written (L14). */
export type FieldNote = 'add_time' | 'am_pm' | 'which_day' | 'midnight' | 'time_dropped';

/** A resolved reference as stored in the sealed payload. id: the record's _id (hex); '' only for an update form's
 * unchanged reference the caller can't see. key: the value written into the record. */
export interface StoredRef { module: string; id: string; key: string; label: string; number?: string }
export type StoredRefValue = StoredRef | StoredRef[];
export type RefResolution =
  | { state: 'resolved'; ref: StoredRef }
  | { state: 'ambiguous'; module: string; text: string; candidates: EntityChoice[]; more: boolean }
  | { state: 'not_found'; module: string; text: string | null }
  | { state: 'refused'; module: string; reason: 'disabled' | 'no_permission' | 'unknown_module' | 'tenant_inactive' | 'scope_failed' | 'bad_id' | 'outside_parent' | 'not_a_user' };

export interface CustomFieldDef { key: string; fieldKey: string; label: string; type: CustomFieldType; options: string[]; required: boolean; writable: boolean }
export interface StageOption { key: string; label: string; color?: string; terminal: boolean }

/** Everything a form needs to know about the caller, loaded once per request (prefill.loadFormContext). */
export interface FormContext {
  module: string; op: WriteOp;
  timezone: string; todayKey: string; now: Date;
  scope: DataScope;
  /** The module's own PII (piiConfig.viewRoles of the caller's branch settings, or an admin). */
  piiVisible: boolean;
  customerPiiVisible: boolean; sitePiiVisible: boolean;
  /** users.view (L25): owner pickers shown. */
  canPickUsers: boolean;
  ownStaff: StoredRef | null;
  ownUser: StoredRef;
  stageOptions: Readonly<Record<string, readonly StageOption[]>>;
  stageDefaults: Readonly<Record<string, string | null>>;
  enumOptions: Readonly<Record<string, readonly string[]>>;
  customFields: readonly CustomFieldDef[];
  fsDefaults: { discount: number; gst: number } | null;
  defaultDurationHours: number | null;
  staffHardBlock: boolean;
  branchCurrency: string | null;
  refAccess: Readonly<Record<string, 'ok' | 'disabled' | 'no_permission' | 'unknown_module' | 'tenant_inactive'>>;
}

/** The open form's fields, without values (the write grammar's fill reader, the planner catalog). */
export interface FillField {
  key: string; label: string; kind: WriteFieldKind;
  options?: Array<{ value: string; label: string }>;
  refModules?: string[]; required: boolean; filled: boolean; future?: boolean;
}
export interface FillFormSpec { module: string; op: 'create' | 'update'; fields: FillField[] }
export type FillParse =
  | { kind: 'fill'; values: Record<string, WriteValue>; refs: Record<string, RefInput | RefInput[]>; fieldNotes: Record<string, FieldNote> }
  | { kind: 'cancel' } | { kind: 'review' };

export type WriteParse =
  | { kind: 'intent'; intent: WriteIntent; notTaken: string[]; fieldNotes: Record<string, FieldNote> }
  | { kind: 'read_like' } | { kind: 'uncertain' } | { kind: 'not_workflow' };

export interface WriteRuleContext {
  op: WriteOp; mode: 'draft' | 'review' | 'commit';
  identity: AssistIdentity; tenant: GatewayTenant; ctx: FormContext;
  /** Write data: create = every value; update = the changed values; delete = {}. */
  values: Readonly<Record<string, unknown>>;
  form: Readonly<Record<string, FormValue>>;
  refs: Readonly<Record<string, StoredRefValue>>;
  /** update: fields whose origin isn't 'source'. */
  changed: ReadonlySet<string>;
  record: Readonly<Record<string, unknown>> | null;
  related: RelatedGate;
  /** Increment 7, a document create: its lines, the record it is made from, and its totals (null: not worked out). */
  lines?: readonly SealedLine[]; source?: SourceSnapshot; totals?: DocumentTotals | null;
}
export interface WriteRuleResult {
  fieldErrors: Record<string, string>; formErrors: string[]; warnings: string[]; sideEffects: SideEffect[];
  /** delete: refuses before any review (shown as a notice). */
  blocked?: string;
  quickPicks?: Record<string, Array<{ label: string; value: FormValue }>>;
}
export interface WriteRules { check(input: WriteRuleContext): Promise<WriteRuleResult> }
export type PrefillValue = string | number | boolean | null | string[];
export interface WorkflowModule {
  cap: WriteCap;
  rules?: WriteRules;
  fullFormPrefill?: (input: { form: Readonly<Record<string, FormValue>>; refs: Readonly<Record<string, StoredRefValue>>;
    values: Readonly<Record<string, unknown>>; branchId: string | null; ctx: FormContext }) => Record<string, PrefillValue>;
  /** Increment 7: a create made from another record (an invoice from a work order). */
  source?: SourceSpec;
  /** The lock Confirm's re-check and write of a create run under; null: none. */
  commitLock?: (sealed: WorkflowSealed, tenantId: string) => CommitLock | null;
  /** A service's error as the person may read it, scoped; null: the generic text. */
  mapWriteError?: (input: ApplyContext & { message: string }) => Promise<string | null>;
  /** After an applied create: one more sentence for the result. */
  afterApply?: (input: ApplyContext & { recordId: string; number?: string }) => Promise<string | null>;
}

export interface RefDeps {
  identity: AssistIdentity; tenant: GatewayTenant; gate: RelatedGate;
  focus: { module: string; id: string } | null; ctx: FormContext;
  resolved: Readonly<Record<string, StoredRefValue | undefined>>;
}

export interface StackInput {
  wf: WorkflowModule; def: CrmWriteModuleDef; cap: ModuleCap; op: 'create' | 'update';
  mode: 'draft' | 'review' | 'commit';
  identity: AssistIdentity; tenant: GatewayTenant; ctx: FormContext; related: RelatedGate;
  fields: readonly WriteFormField[];
  form: Record<string, FormValue>; origins: Record<string, FormOrigin>;
  masked: readonly string[];
  refs: Record<string, StoredRefValue>;
  record: Record<string, unknown> | null;
  /** Increment 7, a document create: its lines and the record it is made from. */
  lines?: readonly SealedLine[]; source?: SourceSnapshot;
}
export interface StackResult {
  values: Record<string, unknown>; refs: Record<string, StoredRefValue>;
  fieldErrors: Record<string, string>; missing: string[]; formErrors: string[]; warnings: string[];
  sideEffects: SideEffect[]; labels: Record<string, string>; writable: string[];
  quickPicks: Record<string, Array<{ label: string; value: FormValue }>>;
  ready: boolean;
  /** Increment 7, a document create: the lines as rechecked, their errors ('lines', 'lines.<key>'), the totals
   * as the blocks show them and as the service computes them (null: not worked out). */
  lines?: SealedLine[]; lineErrors?: Record<string, string>; totals?: Totals | null; documentTotals?: DocumentTotals | null;
}

export interface FormBlockInput {
  operationId: string; revision: number; expiresAt: Date;
  wf: WorkflowModule; cap: ModuleCap; op: 'create' | 'update'; ctx: FormContext;
  fields: readonly WriteFormField[];
  target?: EntityRef & { href?: AppLink };
  form: Record<string, FormValue>; origins: Record<string, FormOrigin>; masked: readonly string[];
  candidates: Record<string, EntityChoice[]>; hints: Record<string, string>;
  fieldErrors: Record<string, string>; missing: readonly string[]; formErrors: readonly string[];
  warnings: readonly string[]; notTaken: readonly string[]; sideEffects: readonly SideEffect[];
  quickPicks: Record<string, Array<{ label: string; value: FormValue }>>;
  fullFormPrefill: Record<string, PrefillValue> | null;
  scopeKind: DataScope['kind'];
  /** Increment 7, a document create: its lines and totals, the fields its source fixes, and the source's number. */
  lines?: FormLines; totals?: Totals | null; readOnlyKeys?: readonly string[]; fromNumber?: string;
}
export interface WorkflowReviewInput {
  operationId: string; revision: number; payloadHash: string; expiresAt: Date;
  wf: WorkflowModule; cap: ModuleCap; def: CrmWriteModuleDef; op: WriteOp; ctx: FormContext;
  target?: EntityRef & { href?: AppLink };
  changes: FieldChange[];
  /** update/delete: the record as this caller may see it (PII-protected). */
  shown: Record<string, unknown>;
  refs: Record<string, StoredRefValue>;
  warnings: readonly string[]; sideEffects: readonly SideEffect[];
  editable: boolean; scopeKind: DataScope['kind'];
  /** Increment 7, a document create: its lines and totals. */
  lines?: LineRow[]; totals?: Totals;
}

export interface StartInput {
  intent: WriteIntent; source: StartSource;
  notTaken?: string[]; fieldNotes?: Record<string, FieldNote>;
  focus: { module: string; id: string } | null;
  /** Epoch ms by which the reply is due. */
  deadline: number;
}
export interface WorkflowCaller { identity: AssistIdentity; tenant: GatewayTenant; sessionId: string; url: string; now?: Date }
export type WorkflowReply =
  | { kind: 'form'; operationId: string; block: FormBlock; notices: NoticeBlock[] }
  | { kind: 'review'; operationId: string; block: ReviewBlock; notices: NoticeBlock[]; confirmation: OperationConfirmation }
  | { kind: 'result'; operationId: string; block: ResultBlock; notices: NoticeBlock[] }
  | { kind: 'clarify'; composed: ComposedAnswer }
  | { kind: 'notice'; notice: NoticeBlock }
  | { kind: 'refused'; http: 400 | 403 | 404 | 409; message: string; block?: FormBlock | ReviewBlock | ResultBlock }
  | { kind: 'not_workflow' };

/* ── Documents (Increment 7): lines, the record a create is made from, the confirm hooks ── */

/** The validate body's line edits (contracts/views.ts), for the lifecycle. */
export type { LineEdit };

/** One row of a document's lines as the draft holds it (sealed, so encrypted at rest). */
export interface SealedLine {
  /** LineKeySchema: 's<i>'/'p<i>' carried from a source, 'c<i>' priced from the request's words, the browser's 'n<i>'. */
  key: string;
  kind: 'service' | 'part';
  origin: 'catalog' | 'source';
  qty: number;
  /** catalog: the record picked and its price as last read on the server. */
  catalog?: { id: string; name: string; number?: string; price: number; partNumber?: string };
  /** source: the line exactly as the source stores it (written verbatim; the screen's Zod keeps its known keys). */
  line?: Record<string, unknown>;
}

/** A create made from another record (an invoice from a work order), as start read it. */
export interface SourceSnapshot {
  module: string; id: string; number: string;
  /** sha256 of what the create copies; review and confirm compare it with the record as it is then. */
  digest: string;
  /** Form keys the source fills and the person can't change (an invoice's customerId). */
  fixedKeys: string[];
  /** Write values the source gives, merged before the screen's Zod (customerId, workOrderId, quotationId, contractId). */
  fixed: Record<string, unknown>;
  /** The records the create marks Converted, by number. */
  linked: Array<{ module: string; number: string }>;
}
export interface SourceStartInput {
  intent: WriteIntent; from: NonNullable<WriteIntent['from']>; focus: { module: string; id: string } | null;
  identity: AssistIdentity; tenant: GatewayTenant; gate: RelatedGate; ctx: FormContext;
}
export type SourceStart =
  | {
      ok: true; from: SourceSnapshot; lines: SealedLine[];
      /** Values prefilled from the source (origin default, provenance source_document), their records, and field help. */
      form: Record<string, FormValue>; refs: Record<string, StoredRefValue>; hints: Record<string, string>; warnings: string[];
    }
  | { ok: false; reply: WorkflowReply };
export interface SourceSpec {
  /** The module a create is made from (intent.from.module, or the record on screen for { focus }). */
  module: string;
  start(input: SourceStartInput): Promise<SourceStart>;
}
/** The lock Confirm's re-check and write run under (writes/locks.ts), and the text when it is held. */
export interface CommitLock { key: { tenantId: string; kind: 'invoice_from_wo'; key: string }; busy: string }
export interface ApplyContext { sealed: WorkflowSealed; identity: AssistIdentity; tenant: GatewayTenant; now: Date }
