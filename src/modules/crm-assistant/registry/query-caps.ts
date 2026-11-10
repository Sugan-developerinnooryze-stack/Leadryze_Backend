import mongoose from 'mongoose';
import type { DataScope } from '../../../types';
import type { DateRule } from '../../daily-events/daily-events.time';
import { RECORD_SOURCES } from '../../daily-events/daily-events.sources';
import {
  applyDataScopeToCreatedByFilter, applyDataScopeToFilter, applyDataScopeToTeamFilter,
} from '../../native-crm/shared/data-scope';
import { enrichDealsWithContactAndCompany } from '../../native-crm/deals/deal.service';
import { PII_FIELDS } from '../../../platform/pii/constants';
import type { FieldCap, ModuleCap } from './types';

/* What executor Q (scoped Mongo queries, Increment 3) needs per module, next
 * to the registry entry: how the caller's DataScope narrows the module (and
 * what that scope keys off, and which "mine" modes always stay inside it),
 * whether it has a branch, which records are open or due, and what Q may
 * search, filter, sort and group by.
 *
 * The scope closure builds the module's CLOSED scope object: it runs exactly the
 * DataScope helper the module's own list() runs, with the same arguments, on an
 * EMPTY object, and returns that object. scoped-match.ts places it, untouched,
 * as one member of { $and: [ base, scope, ...conditions ] }, so no condition,
 * search or sort can ever replace or widen it (plan 4.3). The shared helpers
 * write the scope onto the filtered field itself or into $or, which is why the
 * object must never be merged with anything else. */

/** Builds the module's closed scope object for this caller. */
export type ScopeClosure = (scope: DataScope, ctx: { userId: string; ownerValues(): Promise<string[]> }) =>
  Record<string, unknown> | Promise<Record<string, unknown>>;

export interface QueryCaps {
  module: string;
  /** Executor Q may run this module (false for supervisor: no DataScope; executor L only). */
  q: boolean;
  /** The model has branchId and list() narrows by it (false: company, call, meeting, supervisor). */
  branch: boolean;
  scope: ScopeClosure;
  /** False where list() search breaks the scope (deal: its search $or replaces the scope $or), so search runs on Q. */
  listSearchSafe: boolean;
  /** Executor Q's own escaped, case-insensitive search fields. Never encrypted PII. */
  searchFields: string[];
  /** Open records: stage not terminal, plus this (ticket: { resolvedAt: null, closedAt: null }). */
  openFilter?: Record<string, unknown>;
  /** "overdue" and "due today": this date field and its DateRule (the Daily Events source's own, where the
   * module has one); overdueExtra is added for overdue only. Absent: those states are unsupported. */
  due?: { field: string; rule: DateRule; overdueExtra?: Record<string, unknown> };
  /** "expiring": the end date (the Daily Events source's date field and DateRule) falls in a window, the
   * plan's range or else the next 30 days, while the record still runs. running 'active': the stage the
   * tenant tagged with the outcome 'active' (the key 'active' when none is), the contracts the visit
   * scheduler and Daily Events treat as running; 'open': any stage that isn't terminal. `also` must hold
   * too. Absent: the state is unsupported. */
  expiring?: { field: string; rule: DateRule; running: 'active' | 'open'; also?: Record<string, unknown> };
  /** The collation the module's own list() reads with (lead and contact: case-insensitive, so "acme ltd"
   * sorts before "Zeta Corp"; LR-LEAD-007, LR-UX-010). Executor Q applies it to every find, count and
   * aggregate: text sorts read as they do on executor L, and a count still equals its list total
   * (a collation also changes how strings match). Absent: the simple (binary) collation. */
  collation?: { locale: string; strength: number };
  /** The references the module's own list() populates, with the same fields (service categoryId, site
   * customerId, staff teamId): executor Q populates them too, so their table cells show the same names
   * on both executors; the read projection (nestedProjection) then trims them as it does on executor L. */
  populate?: Array<{ path: string; select: string }>;
  /** What the module's own list() does to the rows it read before returning them (deal: listDeals'
   * enrichDealsWithContactAndCompany fills a contact or company name the deal doesn't store from its
   * contactId / companyId). Executor Q runs it on its rows too (scopedFind), before PII protection and the
   * read projection, so their table cells show the same names on both executors. Absent: list() returns
   * its rows as read. */
  afterRead?: (tenantId: string, rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
  /** The module's own list() returns full Mongoose documents (not lean), and a document fills the schema's
   * defaults for values a stored record lacks (an old record with no status reads as "active"). Executor Q
   * reads lean rows, so it fills the same static (non-function) defaults for those values, and both executors
   * show the same cells. Absent: list() reads lean rows, which carry no defaults, and Q adds none. */
  listDocuments?: boolean;
  /** What a narrower-than-everything scope keys off, for the source badge's note (views/interpret.ts
   * scopeNoteFor): records created by the caller or their team, assigned to them, either (lead, deal), or
   * owned or created by them (contact). Absent: "<Plural> you can see". */
  scopeBasis?: 'created' | 'assigned' | 'owner_or_created' | 'owned_or_created';
  /** Per "mine" mode (query/mine.ts): true only where the scope always holds every record that mode's
   * condition can match, for any caller. "Mine" only ever narrows the scope, so where it is false a "mine"
   * answer under a narrower scope can leave some of the caller's own records out (tasks assigned to an agent
   * that someone else created: the task scope is "created by you"), and says so (query/mine.ts
   * minePartial). False too for a mode the module can't answer. tests/crm-assist-mine.test.ts checks these
   * against the real scope closures. */
  mineInScope: { assigned: boolean; created: boolean };
}

export type CondOp = 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'within' | 'contains' | 'empty' | 'not_empty';

/* ── Scope closures ────────────────────────────────────────────────────── */

/** The Daily Events source's applyScope, which for these modules is the very
 * call their list() makes (lead, deal, task, ticket, call, meeting, work order,
 * invoice, activity). */
function fromRecordSource(module: string): ScopeClosure {
  const def = RECORD_SOURCES.find((d) => d.module === module);
  if (!def) throw new Error(`No Daily Events source for "${module}"`);
  return (scope) => {
    const scoped: Record<string, unknown> = {};
    def.applyScope(scoped, scope);
    return scoped;
  };
}

/** applyDataScopeToCreatedByFilter(filter, scope): createdBy in the caller's user ids. */
const createdByScope: ScopeClosure = (scope) => {
  const scoped: Record<string, unknown> = {};
  applyDataScopeToCreatedByFilter(scoped, scope);
  return scoped;
};

/** applyDataScopeToFilter(filter, scope, ownerField): the owner field in the caller's staff and user ids. */
function ownerScope(ownerField: string): ScopeClosure {
  return (scope) => {
    const scoped: Record<string, unknown> = {};
    applyDataScopeToFilter(scoped, scope, ownerField);
    return scoped;
  };
}

/** listContacts: createdBy, or contactOwner holding the caller's ids or names. */
const contactScope: ScopeClosure = async (scope, ctx) => {
  const scoped: Record<string, unknown> = {};
  applyDataScopeToCreatedByFilter(scoped, scope, 'createdBy', undefined, ctx.userId, 'contactOwner', await ctx.ownerValues());
  return scoped;
};

/** listTeams: the caller's teams by _id. */
const teamScope: ScopeClosure = (scope) => {
  const scoped: Record<string, unknown> = {};
  applyDataScopeToTeamFilter(scoped, scope);
  return scoped;
};

/** Supervisors have no DataScope (supervisor-read.service.ts); executor Q never runs them. */
const noScope: ScopeClosure = () => ({});

/* ── Per module ────────────────────────────────────────────────────────── */

function dueOf(module: string, overdueExtra?: Record<string, unknown>): QueryCaps['due'] {
  const def = RECORD_SOURCES.find((d) => d.module === module);
  if (!def) throw new Error(`No Daily Events source for "${module}"`);
  return { field: def.dateField, rule: def.dateRule, ...(overdueExtra ? { overdueExtra } : {}) };
}

function openFilterOf(module: string): Record<string, unknown> | undefined {
  const def = RECORD_SOURCES.find((d) => d.module === module);
  return def?.openFilter ? { ...def.openFilter } : undefined;
}

/** QueryCaps.expiring on the Daily Events source's date field and DateRule. */
function expiringOf(module: string, running: 'active' | 'open', also?: Record<string, unknown>): QueryCaps['expiring'] {
  const def = RECORD_SOURCES.find((d) => d.module === module);
  if (!def) throw new Error(`No Daily Events source for "${module}"`);
  return { field: def.dateField, rule: def.dateRule, running, ...(also ? { also } : {}) };
}

function caps(module: string, spec: Omit<QueryCaps, 'module' | 'q' | 'listSearchSafe'> & { q?: boolean; listSearchSafe?: boolean }): QueryCaps {
  return { module, q: spec.q ?? true, listSearchSafe: spec.listSearchSafe ?? true, ...spec };
}

/** QueryCaps.mineInScope: the "mine" modes whose records always stay inside the scope. A createdBy
 * scope always holds the caller's own createdBy, and an owner-field scope (applyDataScopeToFilter: the
 * caller's staff and user ids) the caller's userId and own staffId; the lead, deal and contact scopes
 * take either. So 'created' stays inside the createdBy scopes and the lead, deal and contact ones, and
 * 'assigned' inside the owner-field scopes and where it means created by (the created_by modules).
 * Task assignees (a createdBy scope), and records the caller created under an owner-field scope
 * (customer, work order, meeting, staff, team), can fall outside. */
function mineIn(...modes: Array<keyof QueryCaps['mineInScope']>): QueryCaps['mineInScope'] {
  return { assigned: modes.includes('assigned'), created: modes.includes('created') };
}

/** listLeads' and listContacts' own .collation(...). */
const LIST_COLLATION = Object.freeze({ locale: 'en', strength: 2 });

export const QUERY_CAPS: Readonly<Record<string, QueryCaps>> = Object.freeze({
  /* Native CRM */
  company: caps('company', {
    branch: false, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['name', 'domain', 'city', 'industry'],
  }),
  contact: caps('contact', {
    branch: true, scope: contactScope, scopeBasis: 'owned_or_created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['firstName', 'lastName', 'company', 'jobTitle'], collation: LIST_COLLATION,
  }),
  // The scope is the Tasks page's own (created by you or your team); "my tasks" are the ones assigned to you.
  task: caps('task', {
    branch: true, scope: fromRecordSource('task'), scopeBasis: 'created', mineInScope: mineIn('created'),
    searchFields: ['title', 'assignedTo'], due: dueOf('task'),
  }),
  ticket: caps('ticket', {
    branch: true, scope: fromRecordSource('ticket'), scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['subject', 'contactName', 'ticketNumber'], openFilter: openFilterOf('ticket'), due: dueOf('ticket'),
  }),
  call: caps('call', {
    branch: false, scope: fromRecordSource('call'), scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['contactName'], due: dueOf('call'),
  }),
  meeting: caps('meeting', {
    branch: false, scope: fromRecordSource('meeting'), scopeBasis: 'assigned', mineInScope: mineIn('assigned'),
    searchFields: ['title'], due: dueOf('meeting'),
  }),

  /* Field Service */
  lead: caps('lead', {
    branch: true, scope: fromRecordSource('lead'), scopeBasis: 'owner_or_created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['firstName', 'lastName', 'company', 'leadId'], due: dueOf('lead'), collation: LIST_COLLATION,
  }),
  // deal.service.ts's search sets filter.$or, replacing the scope $or that
  // applyDataScopeToFilter wrote just before it, so a scoped deal search through
  // list() is limited by tenant and branch only. Executor Q searches deals itself.
  deal: caps('deal', {
    branch: true, scope: fromRecordSource('deal'), scopeBasis: 'owner_or_created', mineInScope: mineIn('assigned', 'created'),
    listSearchSafe: false, searchFields: ['title', 'contactName', 'companyName'], due: dueOf('deal'),
    afterRead: (tenantId, rows) => enrichDealsWithContactAndCompany(new mongoose.Types.ObjectId(tenantId), rows),
  }),
  workorder: caps('workorder', {
    branch: true, scope: fromRecordSource('workorder'), scopeBasis: 'assigned', mineInScope: mineIn('assigned'),
    searchFields: ['title', 'workOrderId', 'customerId'], due: dueOf('workorder'), listDocuments: true,
  }),
  invoice: caps('invoice', {
    branch: true, scope: fromRecordSource('invoice'), scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['invoiceId', 'customerId'],
    // Daily Events reads the pipeline only; a paid flag set by receipts also counts as settled here.
    due: dueOf('invoice', { paid: { $ne: true } }),
    listDocuments: true,
  }),
  customer: caps('customer', {
    branch: true, scope: ownerScope('assignedStaffId'), scopeBasis: 'assigned', mineInScope: mineIn('assigned'),
    searchFields: ['name', 'customerId', 'company'], listDocuments: true,
  }),
  site: caps('site', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    // LR-R2-SEC-001: the customer's name only, as listSites now populates (its phone and e-mail are encrypted).
    searchFields: ['name', 'city'], populate: [{ path: 'customerId', select: 'name' }], listDocuments: true,
  }),
  // Staff: the caller's own staff record (a manager's: their teams'); teams: the caller's teams. Neither scope
  // is about who created or is assigned a record, so they have no basis ("Staff you can see").
  staff: caps('staff', {
    branch: true, scope: ownerScope('staffId'), mineInScope: mineIn(),
    searchFields: ['firstName', 'lastName'], populate: [{ path: 'teamId', select: 'name' }], listDocuments: true,
  }),
  team: caps('team', { branch: true, scope: teamScope, mineInScope: mineIn(), searchFields: ['name'], listDocuments: true }),
  supervisor: caps('supervisor', { q: false, branch: false, scope: noScope, mineInScope: mineIn(), searchFields: [] }),
  activity: caps('activity', {
    branch: true, scope: fromRecordSource('activity'), scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['subject', 'activityId'], due: dueOf('activity'), listDocuments: true,
  }),
  category: caps('category', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'), searchFields: ['name'], listDocuments: true,
  }),
  service: caps('service', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['name'], populate: [{ path: 'categoryId', select: 'name color icon' }], listDocuments: true,
  }),
  part: caps('part', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'), searchFields: ['name', 'partNumber'], listDocuments: true,
  }),
  product: caps('product', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'), searchFields: ['name', 'sku'], listDocuments: true,
  }),
  // Assets and vehicles have no owner, so no 'assigned' (query/mine.ts refuses it).
  asset: caps('asset', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('created'), searchFields: ['name', 'serialNumber'], listDocuments: true,
  }),
  vehicle: caps('vehicle', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('created'),
    searchFields: ['name', 'registrationNumber', 'make'], listDocuments: true,
  }),
  expense: caps('expense', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'), searchFields: ['title', 'category'], listDocuments: true,
  }),

  /* Field Service documents, read only (Increment 5) */
  // Expiring: still open (not approved or rejected) with the validity date in the window.
  quotation: caps('quotation', {
    branch: true, scope: fromRecordSource('quotation'), scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['title', 'quotationId', 'customerId'], due: dueOf('quotation'), listDocuments: true,
    expiring: expiringOf('quotation', 'open'),
  }),
  // Scoped by the assigned staff (staffIds), like work orders. Expiring: running (the active outcome) with the
  // end date in the window; one marked "no end date" never expires, whatever end date the form stored for it.
  // The end date is read with Daily Events' 'date' rule: stored at 23:59:59.999 UTC on the picked day, it is
  // the next day for a tenant east of UTC, as on the Contracts page and in Daily Events (kept the same on purpose).
  contract: caps('contract', {
    branch: true, scope: fromRecordSource('contract'), scopeBasis: 'assigned', mineInScope: mineIn('assigned'),
    searchFields: ['title', 'contractId', 'customerId'], due: dueOf('contract'), listDocuments: true,
    expiring: expiringOf('contract', 'active', { noEndDate: { $ne: true } }),
  }),
  // Not a Daily Events source: no due date. Open receipts are the pending ones (the registry's terminal statuses).
  receipt: caps('receipt', {
    branch: true, scope: createdByScope, scopeBasis: 'created', mineInScope: mineIn('assigned', 'created'),
    searchFields: ['receiptId', 'invoiceId', 'customerId'], listDocuments: true,
  }),
});

export function queryCapsFor(module: string): QueryCaps | undefined {
  return Object.prototype.hasOwnProperty.call(QUERY_CAPS, module) ? QUERY_CAPS[module] : undefined;
}

/* ── Field rules ───────────────────────────────────────────────────────── */

function topLevel(path: string): string {
  return path.split('.')[0];
}

/** Registered PII (the field's own flag, or the module's PII_FIELDS entry). */
export function isPiiField(cap: ModuleCap, field: FieldCap): boolean {
  if (field.pii) return true;
  const def = PII_FIELDS[cap.gate.scopeKey];
  const key = topLevel(field.path);
  return !!def && (def.level2.includes(key) || def.level3.includes(key));
}

const NUMERIC_OPS: readonly CondOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'];
const DATE_OPS: readonly CondOp[] = ['gt', 'gte', 'lt', 'lte', 'between', 'within', 'empty', 'not_empty'];
const ENUM_OPS: readonly CondOp[] = ['eq', 'ne', 'in', 'nin', 'empty', 'not_empty'];
const TEXT_OPS: readonly CondOp[] = ['eq', 'ne', 'in', 'nin', 'contains', 'empty', 'not_empty'];
const BOOL_OPS: readonly CondOp[] = ['eq', 'ne'];
const NONE: readonly CondOp[] = [];

/** Fields a person can see somewhere in the app's answers, and whose values are not protected. */
function isOpenField(cap: ModuleCap, field: FieldCap): boolean {
  return field.read !== 'hidden' && !field.virtual && !isPiiField(cap, field);
}

/** Operators a condition may use on this field; [] = no condition allowed. */
export function conditionOpsFor(cap: ModuleCap, field: FieldCap): readonly CondOp[] {
  if (!isOpenField(cap, field)) return NONE;
  switch (field.kind) {
    case 'number': case 'money': case 'percent': case 'duration': return NUMERIC_OPS;
    case 'date': case 'datetime': return DATE_OPS;
    case 'enum': case 'stage': return ENUM_OPS;
    case 'id': case 'text': case 'longtext': return TEXT_OPS;
    case 'ref': return field.ref?.idFormat === 'business' ? TEXT_OPS : NONE;
    case 'boolean': return BOOL_OPS;
    default: return NONE;   // ref_many, line_items, email, phone
  }
}

/** Executor Q can sort by it. */
export function isQuerySortable(cap: ModuleCap, field: FieldCap): boolean {
  if (!isOpenField(cap, field)) return false;
  switch (field.kind) {
    case 'ref_many': case 'line_items': case 'email': case 'phone': case 'longtext': return false;
    case 'ref': return field.ref?.idFormat === 'business';
    default: return true;
  }
}

/** Executor Q can group by it (date fields need a bucket). */
export function isQueryGroupable(cap: ModuleCap, field: FieldCap): boolean {
  if (!isOpenField(cap, field)) return false;
  return field.kind === 'enum' || field.kind === 'stage' || field.kind === 'boolean' || field.kind === 'date' || field.kind === 'datetime';
}

/** A money field whose currency is stored on each record (deal amount). Sorting
 * or comparing it means something only within one currency, so only executor Q
 * (which adds the currency as a condition) may sort or compare it; the module's
 * own list() would rank amounts of different currencies together. */
export function hasPerRecordCurrency(field: FieldCap): boolean {
  return field.kind === 'money' && !!field.money && typeof field.money.currency === 'object';
}

/** The module's main amount: the first money field that is stored and not hidden. */
export function amountFieldOf(cap: ModuleCap): FieldCap | undefined {
  return cap.fields.find((f) => f.kind === 'money' && !f.virtual && f.read !== 'hidden');
}

/** The record states executor Q can filter this module by (validate.ts and
 * compile.ts use it; the grammar may too). open / closed need a stage that
 * can finish: the tenant pipeline, or a schema enum with terminal values.
 * overdue / due today also need the module's due date (QueryCaps.due);
 * expiring needs QueryCaps.expiring (contracts, quotations), and a pipeline
 * when it reads the tenant's 'active' outcome (only pipelines tag outcomes). */
export function queryStatesFor(cap: ModuleCap): { open: boolean; closed: boolean; overdue: boolean; dueToday: boolean; expiring: boolean } {
  const qc = queryCapsFor(cap.key);
  const stage = cap.stage;
  const finishes = !!qc?.q && !!stage && ('pipeline' in stage || stage.terminal.length > 0);
  const due = finishes && !!qc?.due;
  const running = qc?.expiring?.running;
  const expiring = finishes && (running === 'open' || (running === 'active' && !!stage && 'pipeline' in stage));
  return { open: finishes, closed: finishes, overdue: due, dueToday: due, expiring };
}
