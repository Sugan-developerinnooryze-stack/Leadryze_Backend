import type { Model } from 'mongoose';
import type { BuiltInPipelineModule } from '../../native-crm/pipeline-config/pipeline-config.model';
import type { DateRule } from '../../daily-events/daily-events.time';
import type { RouteTemplate } from '../contracts/routes';

/* What the assistant knows about each built-in module: names and synonyms the
 * grammar matches, the gates that must pass, which fields a table or record
 * card may show, and where its pages are. Hand-written entries live in
 * native-crm.ts and field-service.ts; introspect.ts and validate.ts check them
 * against the real Mongoose schemas (fail closed at boot, fail CI in
 * tests/crm-assist-registry-drift.test.ts).
 *
 * Increment 1 uses labels, gate, ids, fields (list/detail tiers), sort,
 * search, stage and routes. relations, metrics and write caps arrive in later
 * increments as new optional fields. */

export type FieldKind =
  | 'id' | 'text' | 'longtext' | 'number' | 'money' | 'percent' | 'duration' | 'date' | 'datetime'
  | 'boolean' | 'enum' | 'stage' | 'ref' | 'ref_many' | 'line_items' | 'email' | 'phone';

export interface FieldCap {
  /** Key used in plans and cells; usually equals path. */
  key: string;
  /** Schema path ("dueDate", "customFields.region", "address.city"). */
  path: string;
  label: string;
  synonyms?: string[];
  kind: FieldKind;
  /** Projection tier: 'list' may appear in tables and cards, 'detail' only on
   * a record card, 'hidden' never leaves the engine. */
  read: 'list' | 'detail' | 'hidden';
  /** Table column priority for 'list' fields: 1 is always shown, 2 and 3 drop
   * out first on narrow panels. Fields without one are not table columns. */
  priority?: 1 | 2 | 3;
  dateRule?: DateRule;
  /** Date fields the services store at 23:59:59.999 UTC on the day picked
   * (the contract's end date): a card or table shows that UTC day, the day the
   * form shows. Conditions still read the field with dateRule, as Daily Events
   * does. */
  endOfDayUtc?: true;
  /** A date its form leaves optional, with no default, that date windows use
   * (a receipt's payment date): a window on it leaves out every record without
   * one, so executor Q says how many (execute-query.ts undatedNotices). */
  undatedNotice?: true;
  money?: { currency: 'fs_branch' | { field: string } | 'none' };
  unit?: 'minutes' | 'seconds' | 'hours';
  /** The stored values don't share one unit across the screens and services
   * that write them (call.duration: minutes on the Calls screen, seconds in
   * this registry, analytics and the classic assistant's writes). No
   * condition may use the field until the data is settled; it can still be
   * shown and sorted. */
  unitUncertain?: true;
  /** Registered PII (backend/src/platform/pii/constants.ts): masked unless the
   * caller may see it; encrypted fields are never regex-searched, sorted or grouped. */
  pii?: { module: string; encrypted: boolean; blindIndex?: string };
  ref?: { module: string; targetField: string; idFormat: 'business' | 'objectId' };
  enumFrom?: 'schema' | { pipeline: BuiltInPipelineModule };
  /** Computed by the engine, not a schema path (introspection skips it). */
  virtual?: boolean;
  /** Filled in by introspect.ts from Model.schema.path(path). */
  schema?: Readonly<{ instance: string; enumValues?: string[]; isArray: boolean }>;
}

export type MineRule =
  | { kind: 'owner_ids'; field: string; match: Array<'userId' | 'ownStaffId'> }
  | { kind: 'staff_array'; field: string }
  | { kind: 'contact_owner' }
  | { kind: 'created_by' }
  | { kind: 'unsupported'; reason: string };

export interface ModuleCap {
  /** Equals the CRM_WRITE_MODULE_MAP key (backend/src/modules/internal/crm-write.module-map.ts). */
  key: string;
  /** The sidebar group the staff member sees it under; also the SourceRef key. */
  group: 'native_crm' | 'field_service';
  labels: {
    singular: string;
    plural: string;
    /** Lower-case words and phrases the grammar matches, singular and plural
     * ("work order", "work orders", "wo", "job"). No synonym may map to two modules. */
    synonyms: string[];
  };
  gate: {
    /** Must equal the module map's flagKey (and the screen router's requireModuleEnabled key). */
    flagKey: string;
    /** Must equal the module map's permissionPrefix; view = `${permPrefix}.view`. */
    permPrefix: string;
    /** The data-visibility key passed to resolveEffectiveScope: the module map's logModule. */
    scopeKey: string;
  };
  model: () => Model<any>;
  ids: {
    /** Business-number field (workOrderId, invoiceId, customerId, leadId, ...). */
    business?: string;
    /** False where the collection has no unique index on it (WO/INV/QUO/CON). */
    businessUnique: boolean;
    /** Fields joined with " " (first non-empty group wins) to name a record. */
    title: string[];
  };
  stage?: { field: string; pipeline: BuiltInPipelineModule } | { field: string; enumFrom: 'schema'; terminal: string[] };
  dates: { default: string; created: string; due?: string; start?: string; end?: string };
  mine: MineRule;
  /** False when the module's create paths don't record who created a record
   * (meetings: the Meetings screen and widget bookings never set createdBy),
   * so "created by me" can't be told. Absent: createdBy is recorded. */
  createdByRecorded?: false;
  search: {
    /** Increment 1: search always goes through the module's own list(). */
    delegateToList: true;
    /** True when list() compiles the raw text, so the module-map closure escapes it (Increment 0). */
    escapeAtCallSite: boolean;
  };
  sort: {
    /** What list() returns by default, for the "newest first" sentence. */
    default: { by: string; dir: 'asc' | 'desc' };
    /** Fields list() itself can sort by (Increment 3 uses them). */
    listSortable: string[];
  };
  fields: FieldCap[];
  /** Every other schema path, with the reason it is not offered. Together
   * with `fields` this must cover every path of the schema (drift test). */
  ignoredPaths: Record<string, 'secret' | 'system' | 'internal' | 'detail_only'>;
  routes: RouteTemplate;
}

/* ── Write capabilities (Increment 6): what a guided form may write, per module. ── */
export type WriteOp = 'create' | 'update' | 'delete';
export type WriteFieldKind =
  | 'text' | 'longtext' | 'email' | 'phone' | 'number' | 'money' | 'percent'
  | 'date'        // stored 'YYYY-MM-DD' (UTC midnight), the day picked
  | 'datetime'    // stored as an ISO instant converted from a tenant wall time (wall-time.ts)
  | 'enum' | 'multiselect' | 'stage' | 'boolean'
  | 'ref'         // one record of ref.module, stored by ref.store
  | 'ref_many'    // several (work order staffIds)
  | 'owner_user'  // a CRM user: User._id of this tenant, active, not SUPER_ADMIN, not FS staff (L25)
  | 'related';    // relatedModule + relatedId (+ relatedLabel) of one record of related.modules
export interface WriteRefSpec {
  module: string;
  store: 'business' | 'objectId';
  /** The referenced record's stored key: 'customerId', 'siteId', 'teamId', 'staffId', or '_id'. */
  targetField: string;
  /** Narrowed by another ref field of the same form, server-side only: site within customer
   * ({ field: 'customerId', childPath: 'customerId' }), staff within team ({ field: 'teamId', childPath: 'teamId' }):
   * the child's childPath holds the parent's _id. */
  within?: { field: string; childPath: string };
  /** Cleared when that field changes (the screen's cascade). */
  clearedBy?: string;
  maxItems?: number;
}
export interface WriteRelatedSpec { modules: readonly string[]; store: 'objectId' | 'business'; writesLabel: boolean }
export type WriteOptionsSource =
  | { from: 'schema' }                                   // the model's enum at this key (introspected FieldCap.schema.enumValues, else the Zod enum)
  | { from: 'static'; values: readonly string[] }
  | { from: 'pipeline'; pipeline: BuiltInPipelineModule };
export type WriteDefault =
  | { kind: 'value'; value: string | number | boolean }
  | { kind: 'stage'; preferred: string }                 // L16: preferred key when active, else the first active non-terminal stage by order, else the first active
  | { kind: 'fs_discount' } | { kind: 'fs_gst' }
  | { kind: 'branch_currency' }
  | { kind: 'own_staff_if_scoped' };                     // L20
export type WriteQuickPick = 'assign_to_me' | 'today' | 'tomorrow';
export interface WriteFormField {
  key: string; label: string; kind: WriteFieldKind;
  ops: ReadonlyArray<'create' | 'update'>;
  /** Required on create; on update a required field may not be cleared (L18). */
  required: boolean;
  group?: string; help?: string;
  maxLength?: number; min?: number; max?: number; integer?: boolean;
  options?: WriteOptionsSource;
  ref?: WriteRefSpec;
  related?: WriteRelatedSpec;
  default?: WriteDefault;
  /** Registered PII of this module (constants.ts): shown on update only to PII viewers, else masked (L10); masked values refused. */
  pii?: true;
  /** Not registered PII, but a masked-looking value is refused (work order address, D29). */
  refuseMasked?: true;
  plannerFillable: boolean;
  quickPicks?: readonly WriteQuickPick[];
  /** Keys the server derives from this field (lead owner -> leadOwner = the user's "First Last"). */
  sets?: ReadonlyArray<{ key: string; from: 'user_display_name' }>;
  /** A year-less day read from words that is already past means next year's. */
  future?: true;
  /** A stage field: stages never offered, by their outcome tag or key (an invoice's paid stage, which receipts set). */
  stageExclude?: { outcomes: readonly string[]; keys: readonly string[] };
}
export interface WriteManifest {
  will?: Partial<Record<WriteOp, readonly string[]>>;
  later?: Partial<Record<WriteOp, readonly string[]>>;
  blocked?: Partial<Record<WriteOp, readonly string[]>>;
  /** call / task / ticket: the reminder and confirmation pause lines. */
  stampedPause?: true;
  /** No automation rule or flow can target the module: the card leaves out the scheduled-rules line. */
  noScheduledRules?: true;
}
export interface WriteCap {
  module: string;
  ops: readonly WriteOp[];
  /** 'service' when the module map has requiresVersionToken (lead, deal, contact, company); else 'compare_and_set'. */
  versionToken: 'service' | 'compare_and_set';
  fields: readonly WriteFormField[];
  /** Tenant custom fields of the module are added to the form (when customFieldModuleKey(module) is set). */
  customFields: boolean;
  /** Keys never written from a form, even when the screen's Zod schema has them. */
  privilegedFields: readonly string[];
  manifest: WriteManifest;
  /** The field a create's free words name (title, subject, name). Absent: the module has no title, as an invoice. */
  primaryText?: string;
  /** People modules: "Ravi Kumar" -> first word to `first`, the rest to `last`. */
  nameSplit?: { first: string; last: string };
  /** The ref field "for <name>" fills on a create. */
  forRef?: string;
  /** Work orders only: the screen's prefill hand-off (L27). */
  fullForm?: { list: string; keys: readonly string[] };
  /** A document's lines (Increment 7): invoices and quotations. */
  lines?: WriteLineSpec;
  /** Operations answered with this notice instead of a form; never also in `ops`. */
  refused?: Partial<Record<WriteOp, string>>;
}

/** A document's lines (Increment 7): what Add offers in the chat, whether a create needs a line, the most rows,
 * and whose totals the preview runs (NC/shared/document-totals.ts, the service's own). */
export interface WriteLineSpec {
  add: ReadonlyArray<'service' | 'part'>;
  required: boolean;
  max: number;
  totals: 'invoice' | 'quotation';
}
