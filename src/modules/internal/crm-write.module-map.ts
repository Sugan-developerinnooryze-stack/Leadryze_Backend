import { createLead, updateLead, deleteLead, listLeads, getLeadById } from '../native-crm/leads/lead.service';
import { createWorkorder, updateWorkorder, deleteWorkorder, listWorkorders, getWorkorderById, getWorkorderStats } from '../native-crm/workorders/workorder.service';
import { createInvoice, updateInvoice, deleteInvoice, listInvoices, getInvoiceById } from '../native-crm/invoices/invoice.service';
import { listCategories, createCategory, updateCategory, deleteCategory, getCategoryById } from '../native-crm/categories/category.service';
import { listServices, createService, updateService, deleteService, getServiceById } from '../native-crm/services/service.service';
import { listParts, createPart, updatePart, deletePart, getPartById } from '../native-crm/parts/part.service';
import { listProducts, createProduct, updateProduct, deleteProduct, getProductById } from '../native-crm/products/product.service';
import { listAssets, createAsset, updateAsset, deleteAsset, getAssetById } from '../native-crm/assets/asset.service';
import { listVehicles, createVehicle, updateVehicle, deleteVehicle, getVehicleById } from '../native-crm/vehicles/vehicle.service';
import { listExpenses, createExpense, updateExpense, deleteExpense, getExpenseById } from '../native-crm/expenses/expense.service';
import { listCompanies, createCompany, updateCompany, deleteCompany, getCompanyById, getCompanyStats } from '../native-crm/companies/company.service';
import { listTasks, createTask, updateTask, deleteTask, getTaskById, getTaskStats } from '../native-crm/tasks/task.service';
import { listTickets, createTicket, updateTicket, deleteTicket, getTicketById, getTicketStats } from '../native-crm/tickets/ticket.service';
import { listCalls, createCall, updateCall, deleteCall, getCallById, getCallStats } from '../native-crm/calls/call.service';
import { listMeetings, getMeetingStats, getMeetingById } from '../native-crm/meetings/meeting.service';
import { listSites, createSite, updateSite, deleteSite, getSiteById } from '../native-crm/sites/site.service';
import { listTeams, createTeam, updateTeam, deleteTeam } from '../native-crm/teams/team.service';
import { NativeTeam } from '../native-crm/teams/team.model';
import { listStaffs, createStaff, updateStaff, deleteStaff } from '../native-crm/staffs/staff.service';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { listCustomers, createCustomer, updateCustomer, deleteCustomer, getCustomerById, getCustomerStats } from '../native-crm/customers/customer.service';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { getOutcomeStageKey } from '../native-crm/pipeline-config/pipeline-config.service';
import { NativeWorkorder } from '../native-crm/workorders/workorder.model';
import { Task } from '../native-crm/tasks/task.model';
import { Ticket } from '../native-crm/tickets/ticket.model';
import { NativeCategory } from '../native-crm/categories/category.model';
import { NativeService } from '../native-crm/services/service.model';
import { NativePart } from '../native-crm/parts/part.model';
import { NativeProduct } from '../native-crm/products/product.model';
import { NativeAsset } from '../native-crm/assets/asset.model';
import { NativeVehicle } from '../native-crm/vehicles/vehicle.model';
import { NativeExpense } from '../native-crm/expenses/expense.model';
import { NativeSite } from '../native-crm/sites/site.model';
import { Company } from '../native-crm/companies/company.model';
import { Call } from '../native-crm/calls/call.model';
import { Meeting } from '../native-crm/meetings/meeting.model';
import { BuiltInPipelineModule } from '../native-crm/pipeline-config/pipeline-config.model';
import { listDeals, createDeal, updateDeal, deleteDeal, getDealById } from '../native-crm/deals/deal.service';
import { listContacts, createContact, updateContact, deleteContact, getContactById, getContactStats, contactOwnerValues } from '../native-crm/contacts/contact.service';
import { Contact } from '../native-crm/contacts/contact.model';
import { listActivities, createActivity, updateActivity, deleteActivity, getActivityById } from '../native-crm/activities/activity.service';
import { NativeActivity } from '../native-crm/activities/activity.model';
import { listQuotations, getQuotationById, createQuotation, updateQuotation } from '../native-crm/quotations/quotation.service';
import { listContracts, getContractById } from '../native-crm/contracts/contract.service';
import { listReceipts, getReceiptById } from '../native-crm/receipts/receipt.service';
import { NativeReceipt } from '../native-crm/receipts/receipt.model';
import { listSupervisors, getSupervisorById } from './supervisor-read.service';
import { escapeRegex } from '../../utils/escape-regex';
import type { WriteGuard } from '../../utils/stale-write';
import { DataScope } from '../../types';
import { applyDataScopeToFilter } from '../native-crm/shared/data-scope';
import { ITargetFieldDef } from '../native-crm/automation-rules/target-field-catalog';
import { Model } from 'mongoose';
import mongoose from 'mongoose';

export type CrmWriteOperation = 'create' | 'update' | 'delete' | 'view';

/** Where a module's status values come from, for validating the CRM
 * assistant's `status` list/count filter. 'pipeline': tenant-configurable
 * stages (pipeline-config), so the real keys are read per tenant (always a
 * built-in pipeline: peekStages falls back to its defaults).
 * 'enum': a fixed Mongoose enum, read from the model's schema at runtime so
 * it can never drift from the model. */
export type CrmStatusFilterSource =
  | { kind: 'pipeline'; pipelineModule: BuiltInPipelineModule }
  | { kind: 'enum'; model: Model<any>; field: string }
  /** No status concept at all (Supervisors) — a status filter is a 400. */
  | { kind: 'none' };

export interface CrmWriteModuleDef {
  /** Plural, human-readable name used in the gateway's error messages
   * ("Work Orders is turned off for this account.", "Unknown status ... for
   * Invoices."). Matches the AI side's CRM_MODULE_PLURAL_LABELS. */
  label: string;
  /** The tenant feature-flag key the module's HUMAN router is gated with
   * (requireModuleEnabled in native-crm.router.ts) — the assistant gateway
   * checks the very same key, so a module that is turned off in the UI is
   * turned off for the assistant too. */
  flagKey: string;
  /** How the `status` list/count filter is validated (see type above). */
  statusFilter: CrmStatusFilterSource;
  /** Present only for modules whose list() really supports a date window
   * (confirmed by reading listWorkorders/listInvoices: both accept range/
   * dateFrom/dateTo/dateField and fall back to createdAt for an unknown
   * dateField). `defaultField` is what the assistant's `range` filter uses
   * when no dateField is given; `fields` are the ones list() accepts. */
  dateFilter?: { defaultField: string; fields: string[] };
  /** Display allowlist for list/overdue/today results — only for the 5
   * modules that take their schema from getFieldCatalog() instead of
   * `schemaFields` (lead/workorder/invoice/task/ticket). Never includes
   * secrets or system fields (see READ_FORBIDDEN_KEYS in crm-read.service.ts).
   * The Field Service documents (quotation, contract, receipt) use it too:
   * their rows carry line items, which no schemaFields type describes, and
   * /crm-write writes none of them (quotations change only through the
   * guided form), so GET /crm-schema lists no fields for them. */
  readFields?: string[];
  /** For a populated reference: which sub-keys may leave the gateway (e.g.
   * Site's populated customer -> { _id, name }, never its phone/email). */
  nestedProjection?: Record<string, string[]>;
  /** Combined with the operation's permission suffix ('create'/'edit'/
   * 'delete'/'view') to form the exact permission key checked via
   * hasPermission() — the SAME key the equivalent human-facing route for
   * this module already requires (confirmed by reading each module's own
   * *.routes.ts). */
  permissionPrefix: string;
  /** The module name used in NativeCrmLog entries — matches the key used in
   * native-crm-log.middleware.ts's own MODULE_MODEL_MAP, so a chatbot write
   * shows up under the same module grouping a human write would. */
  logModule: string;
  /** Write functions — undefined for every Stage A module (read-only this
   * stage). The gateway checks these are defined before dispatching an
   * operation, so an undefined one is a clean "not supported yet" 400, not
   * a crash. Phase 1's lead/workorder/invoice are the only modules with
   * these populated today. */
  create?: (tenantId: string, data: Record<string, unknown>) => Promise<any>;
  /** `guard` carries the version captured at review (compare-and-set): when
   * given, the write only matches that version and a changed record throws
   * StaleWriteError (409). Screens never pass it. */
  update?: (id: string, tenantId: string, data: Record<string, unknown>, scope?: DataScope, guard?: WriteGuard) => Promise<any>;
  delete?: (id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) => Promise<any>;
  /** Single-record fetch by real _id — used by GET /crm-get (builds an
   * update/delete confirmation's before-snapshot/diff) and by POST
   * /crm-write's stale-check (re-fetches immediately before dispatching an
   * update/delete, comparing against the proposal-time snapshot). Optional:
   * undefined for any module without create/update/delete populated. */
  getById?: (id: string, tenantId: string, scope?: DataScope) => Promise<any>;
  /** Contacts only, and for reads only (GET /crm-get): getById bound to the
   * calling user. A contact's owner (contactOwner) holds a user id, or the
   * user's "First Last" or User.name, and listContacts matches all of them
   * for the caller (contactOwnerValues). getById above matches ids only, so
   * a contact the caller's list shows could come back "not found" from it;
   * this one passes the caller's owner values as well, so it finds what the
   * list shows, and nothing it doesn't. Writes never use it: POST
   * /crm-write and the staged operations look up, update and delete with
   * the functions above, ids only, as the Contacts screen's PUT and DELETE
   * do. A name is not unique (two users can share one), so a contact owned
   * only by a name is never changed from chat. */
  forCaller?: (userId: string) => Pick<CrmWriteModuleDef, 'getById'>;
  /** True for modules whose update() refuses to run without the record's
   * current version token (LR-NEG-001: updatedAt and/or __v — lead, company,
   * deal, contact). POST /crm-write reads the token from the record it
   * re-fetches right before the update and passes it server-side; the
   * assistant can never supply one itself (the C6 allowlist rejects
   * __v/updatedAt in the request body). */
  requiresVersionToken?: boolean;
  /** Read — used by GET /crm-list/:tenantId/:module (search/list) AND, as
   * of Stage A, GET /crm-count/:tenantId/:module (calls this with
   * {limit:1} and reads .total) — deliberately the SAME function the
   * module's own human-facing list screen already calls, so a chatbot
   * count can never silently diverge from whatever filtering (active/
   * archived/branch/etc.) that screen already applies. No separate
   * countDocuments reimplementation exists in this file. */
  list: (
    tenantId: string, opts: { search?: string; limit?: number; page?: number }, branchId?: string | null, scope?: DataScope,
    /** The caller's own userId, passed on as each screen's controller passes
     * req.user.userId: Contacts match owners with it, and Companies, Tasks,
     * Tickets and Calls read ownerTab "my" as createdBy = userId. */
    userId?: string,
    /** The caller's own staffId (resolveOwnStaffId), for ownerTab "my" on the
     * modules assigned by staff record: Work Orders (staffIds) and Meetings
     * (assignedStaffId), as their controllers pass it. Undefined otherwise. */
    ownStaffId?: string | null,
  ) => Promise<{ items: any[]; total: number }>;
  /** Only populated for modules where "overdue" has a real, well-defined
   * meaning — getOverdueCrmModule() (crm-read.service.ts) is the one place
   * that queries `model` directly rather than going through `list`, since
   * none of these modules expose a due-date/terminal-status filter through
   * their own list() options today. */
  model?: Model<any>;
  statusField?: string;
  /** Which field DataScope filters on for THIS module — only consulted by
   * the overdue helper (plain counting never needs it, since it goes
   * through `list`, which already applies whatever scoping that module's
   * own service uses internally). 'staffIds' uses applyDataScopeToFilter;
   * 'createdBy' (the default most modules use) uses
   * applyDataScopeToCreatedByFilter — both reused from shared/data-scope.ts,
   * never reimplemented. */
  overdueConfig?: {
    dateField: string;
    scopeAnchor: 'staffIds' | 'createdBy';
    terminalStatuses: string[] | ((tenantId: string) => Promise<string[]>);
  };
  /** Explicit ALLOWLIST of fields the chatbot may ever mention for this
   * module — hand-authored, never a reflection of the full Mongoose schema,
   * specifically so a credential/internal-only field (e.g. Staff's
   * appPasswordHash/appUsername) can never be exposed even by accident.
   * Only set for modules getFieldCatalog() (automation-rules/
   * target-field-catalog.ts) doesn't already cover — lead/workorder/
   * invoice/task/ticket get their schema from that existing catalog
   * instead, untouched by this file. */
  schemaFields?: ITargetFieldDef[];
  /** The module's own real dashboard-stats function — only populated for
   * the 7 modules that have one (confirmed by reading each body directly:
   * all genuinely apply DataScope to their own Mongo filter, not merely
   * accept an unused parameter). GET /crm-stats calls this directly,
   * unmodified — never a second, parallel aggregation implementation. */
  stats?: (tenantId: string, branchId?: string | null, scope?: DataScope, range?: string, customFrom?: string, customTo?: string) => Promise<any>;
}

/** update's permission suffix is 'edit', not 'update' — confirmed against
 * every Phase 1 module's own *.routes.ts (e.g. lead.routes.ts's
 * `requirePermission('native_crm.leads.edit')` on its PUT route). */
const PERMISSION_SUFFIX: Record<CrmWriteOperation, string> = {
  create: 'create',
  update: 'edit',
  delete: 'delete',
  view: 'view',
};

export function permissionKeyFor(module: string, operation: CrmWriteOperation): string | undefined {
  const def = CRM_WRITE_MODULE_MAP[module];
  if (!def) return undefined;
  return `${def.permissionPrefix}.${PERMISSION_SUFFIX[operation]}`;
}

const STATUS_FIELD_ALLOWLIST: ITargetFieldDef[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
];

/** STATUS_FIELD_ALLOWLIST for a model whose status values are not just
 * active/inactive (Assets and Vehicles: active, in_use, under_maintenance,
 * retired). The options are read from the model's own enum, like the status
 * filter's, so they can never drift from it ('in_use' -> 'In Use'). */
function statusFieldAllowlistFromEnum(model: Model<any>): ITargetFieldDef[] {
  const path: any = model.schema.path('status');
  const values: string[] = Array.isArray(path?.enumValues) ? path.enumValues : [];
  const label = (value: string) => value.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return [
    ...STATUS_FIELD_ALLOWLIST.filter((f) => f.key !== 'status'),
    { key: 'status', label: 'Status', type: 'select', options: values.map((value) => ({ value, label: label(value) })) },
  ];
}

/** Resolves Site's customerId from the business-string customerId
 * crm_find_customer hands the model (e.g. "9A218C-CUS-0008") — Site's own
 * customerId field is a real Mongo ObjectId ref (confirmed in
 * site.model.ts), not a business string like every other linking module.
 * Deliberately a one-off, Site-specific fixup, not a generic relationship
 * resolver. A real ObjectId passed through directly (or no customerId at
 * all) is left alone. */
async function resolveSiteCustomerId(tenantId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = data.customerId;
  if (typeof raw !== 'string' || !raw || mongoose.isValidObjectId(raw)) return data;
  const customer = await NativeCustomer.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), customerId: raw }).select('_id').lean();
  if (!customer) throw new Error(`No Field Service customer found with id "${raw}" — look it up again with crm_find_customer first.`);
  return { ...data, customerId: customer._id };
}

/** Team and Staff's own getTeamById(id, tenantId)/getStaffById(id, tenantId)
 * take NO scope parameter at all — confirmed by reading both files directly
 * — unlike every other module's getById. Used unscoped, GET /crm-get and
 * POST /crm-write's stale-check could let a caller read ANY team/staff
 * record in the tenant regardless of their own DataScope, even though
 * listTeams/listStaffs already correctly scope the equivalent list view.
 * These wrappers apply the same scope those list functions use, so
 * `getById` is scoped everywhere it's consulted — not just at delete time.
 * Team: the scope is checked apart from the lookup (the id must be one of
 * scope.teamIds, held as lower-case hex _ids), and the lookup keeps the id.
 * applyDataScopeToTeamFilter can't be used here: it REPLACES the filter's
 * _id, so a scoped caller got the first team in their scope whatever id
 * was asked (fixed in Increment 7, M24). Staff narrows on staffId, a
 * different key, so applyDataScopeToFilter(..., 'staffId') keeps the _id. */
async function getTeamByIdScoped(id: string, tenantId: string, scope?: DataScope): Promise<any> {
  if (scope && scope.kind !== 'all' && !scope.teamIds.includes(String(id).toLowerCase())) return null;
  return NativeTeam.findOne({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) });
}

async function getStaffByIdScoped(id: string, tenantId: string, scope?: DataScope): Promise<any> {
  const filter: Record<string, unknown> = { _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) };
  applyDataScopeToFilter(filter, scope, 'staffId');
  return NativeStaff.findOne(filter);
}

/** deleteTeam(id, tenantId)/deleteStaff(id, tenantId) also take no scope
 * param — an out-of-scope caller who knows/guesses a record's real _id
 * could otherwise delete it even though they'd never see it in their own
 * scoped list or (now) via GET /crm-get. Re-uses the exact same scoped
 * lookup above as an existence-and-visibility gate immediately before
 * calling the real, unscoped delete — never silently bypassed, and never a
 * second, divergent scoping implementation. The team delete removes the
 * record that lookup found (its _id), never just the id as asked. */
async function deleteTeamScoped(id: string, tenantId: string, scope?: DataScope, ...guard: [WriteGuard?]): Promise<any> {
  const existing = await getTeamByIdScoped(id, tenantId, scope);
  if (!existing) return null;
  return deleteTeam(String(existing._id), tenantId, ...guard);
}

async function deleteStaffScoped(id: string, tenantId: string, scope?: DataScope, ...guard: [WriteGuard?]): Promise<any> {
  const existing = await getStaffByIdScoped(id, tenantId, scope);
  if (!existing) return null;
  return deleteStaff(id, tenantId, ...guard);
}

/** Display allowlists (C5) for the 5 getFieldCatalog() modules. Business
 * ids first, then title/name, status, key dates, amounts and assignee/
 * customer references. Deliberately absent: portalToken, signatureUrl,
 * tenantId, branchId, __v, lock fields, createdBy/updatedBy, search/blind-
 * index fields, chatSessionId, conversationSummary, utm*, photos, location.
 * The order matters a little: the AI side shows the first few keys of a
 * record as its "distinguishing" fields on a confirmation card. */
const LEAD_READ_FIELDS = [
  'leadId', 'firstName', 'lastName', 'company', 'designation', 'email', 'phone', 'mobile',
  'status', 'source', 'rating', 'score', 'priority', 'leadOwner', 'leadOwnerStaffId', 'teamName',
  'city', 'state', 'country', 'expectedRevenue', 'expectedCloseDate', 'isConverted', 'createdAt', 'updatedAt',
];
const WORKORDER_READ_FIELDS = [
  'workOrderId', 'title', 'customerId', 'siteId', 'quotationId', 'contractId', 'contractVisitNumber',
  'teamId', 'staffId', 'staffIds', 'priority', 'status', 'scheduledDate', 'completedDate', 'durationHours',
  'discount', 'gstPercentage', 'createdAt', 'updatedAt',
];
const INVOICE_READ_FIELDS = [
  'invoiceId', 'customerId', 'workOrderId', 'quotationId', 'contractId', 'status', 'dueDate', 'paid',
  'paidAmount', 'balanceDue', 'servicesAmount', 'servicesAmountWithTax', 'partsAmount', 'discount',
  'gstPercentage', 'createdAt', 'updatedAt',
];
const TASK_READ_FIELDS = [
  'title', 'taskStatus', 'priority', 'dueDate', 'assignedTo', 'relatedModule', 'relatedId', 'relatedLabel',
  'createdAt', 'updatedAt',
];
const TICKET_READ_FIELDS = [
  'ticketNumber', 'ticketId', 'subject', 'ticketStatus', 'priority', 'contactName', 'slaStatus',
  'resolutionDueAt', 'firstResponseDueAt', 'resolvedAt', 'closedAt', 'relatedModule', 'relatedLabel',
  'createdAt', 'updatedAt',
];
// Deal has no generated business id; title + stage + amount identify it.
const DEAL_READ_FIELDS = [
  'title', 'stage', 'amount', 'currency', 'closeDate', 'contactName', 'companyName', 'assignedStaffId',
  'contactId', 'companyId', 'createdAt', 'updatedAt',
];
// The read-only Field Service documents: what their screens list and show,
// line items (services, parts) included. Deliberately absent as well: the
// customer address a quotation or contract copies as free text, notes,
// terms, workflowState, a contract's visit schedule and the old scheduler's
// fields.
const QUOTATION_READ_FIELDS = [
  'quotationId', 'title', 'customerId', 'status', 'validUntil', 'servicesAmountWithTax', 'servicesAmount', 'partsAmount',
  'discount', 'gstPercentage', 'contractId', 'siteId', 'staffId', 'teamId', 'services', 'parts', 'createdAt', 'updatedAt',
];
const CONTRACT_READ_FIELDS = [
  'contractId', 'title', 'customerId', 'status', 'contractType', 'priority', 'startDate', 'endDate', 'noEndDate',
  'servicesAmountWithTax', 'servicesAmount', 'partsAmount', 'discount', 'gstPercentage', 'quotationId', 'siteId',
  'teamId', 'staffIds', 'renewalType', 'woGenerationMode', 'services', 'parts', 'createdAt', 'updatedAt',
];
const RECEIPT_READ_FIELDS = [
  'receiptId', 'invoiceId', 'customerId', 'amount', 'paymentMethod', 'paymentDate', 'status', 'createdAt', 'updatedAt',
];

/** For the list() services that compile the search text into a RegExp as is
 * (workorder, invoice, category, service, part, product, asset, vehicle,
 * expense, site, team, staff, customer, activity, quotation, contract and
 * receipt; re-checked in each service). The assistant passes user words, so
 * they are escaped here, once:
 * a stray "(" would otherwise throw, and ".*" would match everything. The
 * services stay unchanged, because the screens and the widget's /crm-search
 * call them too (D27). Modules whose service escapes the text itself (lead,
 * deal, contact, company, task, ticket, call, meeting, supervisor) get it
 * unchanged, so it is never escaped twice. */
function withEscapedSearch<T extends { search?: string }>(opts: T): T {
  return typeof opts.search === 'string' && opts.search ? { ...opts, search: escapeRegex(opts.search) } : opts;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Contact email is required and is the dedupe/search key. The human route
 * validates its format with Zod (contact.validation.ts); this gateway calls
 * the service directly, so the same check is applied here. A masked value
 * (from a non-admin's view) is left for updateContact, which ignores it. */
function assertContactEmail(data: Record<string, unknown>, required: boolean): Record<string, unknown> {
  const email = data.email;
  if (email === undefined && !required) return data;
  if (typeof email !== 'string' || !email.trim()) throw new Error('A contact needs an email address.');
  const masked = email.includes('*') || /X{2,}/.test(email);
  if (!(masked && !required) && !EMAIL_RE.test(email.trim())) throw new Error(`"${email}" is not a valid email address.`);
  return data;
}

/** The module capability registry — the single authoritative allowlist of
 * what the CRM chatbot can see/touch. POST /crm-write, GET /crm-list, GET
 * /crm-count, GET /crm-overdue, and GET /crm-schema (internal.routes.ts)
 * all reject any :module not listed here before doing anything else.
 * Extend this (Stage B) to add write support to a module already listed
 * here for read; the gateway's own dispatch logic never needs to change to
 * support a new module, only this map. */
export const CRM_WRITE_MODULE_MAP: Record<string, CrmWriteModuleDef> = {
  // update/delete pass the compare-and-set guard on as `...guard`, so a call
  // without one reaches the service with exactly the arguments it had before.
  // Lead, company, deal and contact updates keep their version token instead.
  // ── Phase 1 — full CRUD, already live-verified ──────────────────────────
  lead: {
    permissionPrefix: 'native_crm.leads',
    logModule: 'leads',
    label: 'Leads', flagKey: 'fs_leads',
    // Lead status is a tenant-configurable stage (lead.model.ts: "Stage
    // validity is enforced at the service layer"), not a fixed enum.
    statusFilter: { kind: 'pipeline', pipelineModule: 'lead' },
    readFields: LEAD_READ_FIELDS,
    requiresVersionToken: true,
    create: (tenantId, data) => createLead({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateLead(id, tenantId, data, scope),
    delete: (id, tenantId, scope, ...guard) => deleteLead(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getLeadById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listLeads(tenantId, opts as any, branchId, scope),
  },
  workorder: {
    permissionPrefix: 'fs.workorders',
    logModule: 'workorders',
    label: 'Work Orders', flagKey: 'fs_workorders',
    statusFilter: { kind: 'pipeline', pipelineModule: 'workorder' },
    dateFilter: { defaultField: 'scheduledDate', fields: ['scheduledDate', 'completedDate', 'createdAt'] },
    readFields: WORKORDER_READ_FIELDS,
    create: (tenantId, data) => createWorkorder({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateWorkorder(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteWorkorder(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getWorkorderById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope, _userId, ownStaffId) => listWorkorders(tenantId, withEscapedSearch(opts) as any, branchId, scope, ownStaffId),
    stats: (tenantId, branchId, scope, range, customFrom, customTo) => getWorkorderStats(tenantId, branchId, scope, range, customFrom, customTo),
    model: NativeWorkorder,
    overdueConfig: {
      dateField: 'scheduledDate',
      scopeAnchor: 'staffIds',
      terminalStatuses: async (tenantId: string) => Promise.all([
        getOutcomeStageKey(tenantId, 'workorder', 'completed', 'completed'),
        getOutcomeStageKey(tenantId, 'workorder', 'cancelled', 'cancelled'),
      ]),
    },
  },
  invoice: {
    permissionPrefix: 'fs.invoices',
    logModule: 'invoices',
    label: 'Invoices', flagKey: 'fs_invoices',
    // Invoice status is a tenant-configurable stage too (invoice.model.ts).
    statusFilter: { kind: 'pipeline', pipelineModule: 'invoice' },
    dateFilter: { defaultField: 'dueDate', fields: ['dueDate', 'createdAt'] },
    readFields: INVOICE_READ_FIELDS,
    create: (tenantId, data) => createInvoice({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateInvoice(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteInvoice(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getInvoiceById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listInvoices(tenantId, withEscapedSearch(opts) as any, branchId, scope),
  },

  // ── Stage B increment 1 — full CRUD, live-verified ──────────────────────
  category: {
    permissionPrefix: 'fs.categories', logModule: 'categories', statusField: 'status',
    label: 'Categories', flagKey: 'fs_categories', statusFilter: { kind: 'enum', model: NativeCategory, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listCategories(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createCategory({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateCategory(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteCategory(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getCategoryById(id, tenantId, scope),
    schemaFields: STATUS_FIELD_ALLOWLIST,
  },
  service: {
    permissionPrefix: 'fs.services', logModule: 'services', statusField: 'status',
    label: 'Services', flagKey: 'fs_services', statusFilter: { kind: 'enum', model: NativeService, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listServices(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createService({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateService(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteService(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getServiceById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'categoryId', label: 'Category', type: 'text' }, { key: 'price', label: 'Price', type: 'number' }, { key: 'duration', label: 'Duration', type: 'number' }],
  },
  part: {
    permissionPrefix: 'fs.parts', logModule: 'parts', statusField: 'status',
    label: 'Parts', flagKey: 'fs_parts', statusFilter: { kind: 'enum', model: NativePart, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listParts(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createPart({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updatePart(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deletePart(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getPartById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'partNumber', label: 'Part Number', type: 'text' }, { key: 'price', label: 'Price', type: 'number' }, { key: 'quantity', label: 'Quantity', type: 'number' }],
  },
  product: {
    permissionPrefix: 'fs.products', logModule: 'products', statusField: 'status',
    label: 'Products', flagKey: 'fs_products', statusFilter: { kind: 'enum', model: NativeProduct, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listProducts(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createProduct({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateProduct(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteProduct(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getProductById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'sku', label: 'SKU', type: 'text' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'sellingPrice', label: 'Selling Price', type: 'number' }, { key: 'stock', label: 'Stock', type: 'number' }],
  },
  asset: {
    permissionPrefix: 'fs.assets', logModule: 'assets', statusField: 'status',
    label: 'Assets', flagKey: 'fs_assets', statusFilter: { kind: 'enum', model: NativeAsset, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listAssets(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createAsset({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateAsset(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteAsset(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getAssetById(id, tenantId, scope),
    schemaFields: [...statusFieldAllowlistFromEnum(NativeAsset), { key: 'serialNumber', label: 'Serial Number', type: 'text' }, { key: 'purchaseDate', label: 'Purchase Date', type: 'date' }, { key: 'warrantyExpiry', label: 'Warranty Expiry', type: 'date' }, { key: 'condition', label: 'Condition', type: 'select', options: [{ value: 'new', label: 'New' }, { value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Poor' }] }],
  },
  vehicle: {
    permissionPrefix: 'fs.vehicles', logModule: 'vehicles', statusField: 'status',
    label: 'Vehicles', flagKey: 'fs_vehicles', statusFilter: { kind: 'enum', model: NativeVehicle, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listVehicles(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createVehicle({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateVehicle(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteVehicle(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getVehicleById(id, tenantId, scope),
    schemaFields: [...statusFieldAllowlistFromEnum(NativeVehicle), { key: 'registrationNumber', label: 'Registration Number', type: 'text' }, { key: 'make', label: 'Make', type: 'text' }, { key: 'lastServiceDate', label: 'Last Service Date', type: 'date' }],
  },
  expense: {
    permissionPrefix: 'fs.expenses', logModule: 'expenses', statusField: 'status',
    label: 'Expenses', flagKey: 'fs_expenses', statusFilter: { kind: 'enum', model: NativeExpense, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listExpenses(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createExpense({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateExpense(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteExpense(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getExpenseById(id, tenantId, scope),
    schemaFields: [
      { key: 'title', label: 'Title', type: 'text' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'amount', label: 'Amount', type: 'number' }, { key: 'date', label: 'Date', type: 'date' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }] },
    ],
  },
  // Company/Task/Ticket/Call's own service functions all put tenantId
  // FIRST — create(tenantId, dto)/update(tenantId, id, dto, scope?)/
  // delete(tenantId, id, scope?)/getById(tenantId, id, scope?) — the
  // opposite order from every module above. create's own external
  // signature here is already (tenantId, data), so it needs no reordering;
  // update/delete/getById's external shape is (id, tenantId, ...), so
  // those three closures swap the two arguments before calling through.
  company: {
    permissionPrefix: 'native_crm.companies', logModule: 'companies', statusField: 'companyStatus',
    label: 'Companies', flagKey: 'native_companies', statusFilter: { kind: 'enum', model: Company, field: 'companyStatus' },
    requiresVersionToken: true,
    list: (tenantId, opts, branchId, scope, userId) => listCompanies(tenantId, opts as any, scope, userId) as any,
    create: (tenantId, data) => createCompany(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateCompany(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope, ...guard) => deleteCompany(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getCompanyById(tenantId, id, scope),
    // getCompanyStats(tenantId, scope?) — no branchId/range params, unlike
    // workorder/task/ticket's stats functions; the wrapper just drops what
    // this one doesn't accept. Dropping branchId is correct, not a gap:
    // Company (like Call and Meeting) has no branchId field at all, and the
    // human screens show these modules tenant-wide too.
    stats: (tenantId, _branchId, scope) => getCompanyStats(tenantId, scope),
    schemaFields: [
      { key: 'name', label: 'Name', type: 'text' }, { key: 'domain', label: 'Domain', type: 'text' }, { key: 'industry', label: 'Industry', type: 'text' }, { key: 'employeeCount', label: 'Employee Count', type: 'number' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'country', label: 'Country', type: 'text' },
      { key: 'companyStatus', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'prospect', label: 'Prospect' }] },
    ],
  },
  task: {
    permissionPrefix: 'native_crm.tasks', logModule: 'tasks', statusField: 'taskStatus',
    label: 'Tasks', flagKey: 'native_tasks', statusFilter: { kind: 'pipeline', pipelineModule: 'task' },
    readFields: TASK_READ_FIELDS,
    list: (tenantId, opts, branchId, scope, userId) => listTasks(tenantId, opts as any, branchId, scope, userId),
    create: (tenantId, data) => createTask(tenantId, data as any),
    update: (id, tenantId, data, scope, ...guard) => updateTask(tenantId, id, data as any, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteTask(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getTaskById(tenantId, id, scope),
    stats: (tenantId, branchId, scope, range, customFrom, customTo) => getTaskStats(tenantId, branchId, scope, range, customFrom, customTo),
    model: Task,
    overdueConfig: { dateField: 'dueDate', scopeAnchor: 'createdBy', terminalStatuses: ['done', 'cancelled'] },
    // Schema comes from getFieldCatalog('task') (automation-rules), not schemaFields.
    // createTask/updateTask validate taskStatus against the tenant's real
    // pipeline stage keys (assertValidStatus) and throw a plain Error —
    // bubbles through the gateway's existing generic catch as a clean 400,
    // same as every other business-rule throw.
  },
  ticket: {
    permissionPrefix: 'native_crm.tickets', logModule: 'tickets', statusField: 'ticketStatus',
    label: 'Tickets', flagKey: 'native_tickets', statusFilter: { kind: 'pipeline', pipelineModule: 'ticket' },
    readFields: TICKET_READ_FIELDS,
    list: (tenantId, opts, branchId, scope, userId) => listTickets(tenantId, opts as any, branchId, scope, userId),
    create: (tenantId, data) => createTicket(tenantId, data as any),
    update: (id, tenantId, data, scope, ...guard) => updateTicket(tenantId, id, data as any, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteTicket(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getTicketById(tenantId, id, scope),
    stats: (tenantId, branchId, scope, range, customFrom, customTo) => getTicketStats(tenantId, branchId, scope, range, customFrom, customTo),
    model: Ticket,
    overdueConfig: { dateField: 'resolutionDueAt', scopeAnchor: 'createdBy', terminalStatuses: ['resolved', 'closed'] },
    // Schema comes from getFieldCatalog('ticket'), not schemaFields. Same
    // assertValidStatus pattern as Task. updateTicket ALSO recomputes SLA
    // due dates when priority actually changes (reads the current
    // priority first, only recomputes if it's genuinely different) — a
    // real side effect the AI side discloses in the confirmation summary
    // (see crm-write.tool.ts's SLA note).
  },
  call: {
    permissionPrefix: 'native_crm.calls', logModule: 'calls', statusField: 'callStatus',
    label: 'Calls', flagKey: 'native_calls', statusFilter: { kind: 'enum', model: Call, field: 'callStatus' },
    list: (tenantId, opts, branchId, scope, userId) => listCalls(tenantId, opts as any, scope, userId) as any,
    create: (tenantId, data) => createCall(tenantId, data as any),
    update: (id, tenantId, data, scope, ...guard) => updateCall(tenantId, id, data as any, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteCall(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getCallById(tenantId, id, scope),
    stats: (tenantId, _branchId, scope) => getCallStats(tenantId, scope),
    schemaFields: [
      { key: 'contactName', label: 'Contact Name', type: 'text' }, { key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }] }, { key: 'duration', label: 'Duration (seconds)', type: 'number' }, { key: 'date', label: 'Date', type: 'date' },
      { key: 'callStatus', label: 'Status', type: 'select', options: [{ value: 'planned', label: 'Planned' }, { value: 'completed', label: 'Completed' }, { value: 'missed', label: 'Missed' }, { value: 'cancelled', label: 'Cancelled' }] },
    ],
  },
  meeting: {
    permissionPrefix: 'native_crm.meetings', logModule: 'meetings', statusField: 'meetingStatus',
    label: 'Meetings', flagKey: 'native_meetings', statusFilter: { kind: 'enum', model: Meeting, field: 'meetingStatus' },
    list: (tenantId, opts, branchId, scope, _userId, ownStaffId) => listMeetings(tenantId, opts as any, scope, ownStaffId) as any,
    // getMeetingById(tenantId, id, scope) already applies the same
    // assignedStaffId DataScope filter listMeetings uses — so GET /crm-get
    // can read one meeting without widening what the caller can see.
    getById: (id, tenantId, scope) => getMeetingById(tenantId, id, scope),
    stats: (tenantId, _branchId, scope) => getMeetingStats(tenantId, scope),
    schemaFields: [
      { key: 'title', label: 'Title', type: 'text' }, { key: 'startDate', label: 'Start Date', type: 'date' }, { key: 'endDate', label: 'End Date', type: 'date' }, { key: 'location', label: 'Location', type: 'text' }, { key: 'assignedStaffId', label: 'Assigned Staff', type: 'text' },
      { key: 'meetingStatus', label: 'Status', type: 'select', options: [{ value: 'scheduled', label: 'Scheduled' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }] },
    ],
  },
  site: {
    permissionPrefix: 'fs.sites', logModule: 'sites', statusField: 'status',
    label: 'Sites', flagKey: 'fs_sites', statusFilter: { kind: 'enum', model: NativeSite, field: 'status' },
    // listSites/getSiteById populate customerId with name/phone/email —
    // only the customer's id and name may leave the gateway.
    nestedProjection: { customerId: ['_id', 'name'] },
    list: (tenantId, opts, branchId, scope) => listSites(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: async (tenantId, data) => createSite({ ...(await resolveSiteCustomerId(tenantId, data)), tenantId }),
    update: async (id, tenantId, data, scope, ...guard) => updateSite(id, tenantId, await resolveSiteCustomerId(tenantId, data), scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteSite(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getSiteById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'address', label: 'Address', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'customerId', label: 'Customer', type: 'text' }, { key: 'contactPerson', label: 'Contact Person', type: 'text' }],
  },
  team: {
    permissionPrefix: 'fs.teams', logModule: 'teams', statusField: 'status',
    label: 'Teams', flagKey: 'fs_teams', statusFilter: { kind: 'enum', model: NativeTeam, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listTeams(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createTeam({ ...data, tenantId }),
    // updateTeam already enforces its own scope check internally
    // (scope.teamIds.includes(id)) — reused as-is, not duplicated here.
    update: (id, tenantId, data, scope, ...guard) => updateTeam(id, tenantId, data, scope, ...guard),
    // deleteTeam itself has no scope param — deleteTeamScoped gates it with
    // the same scoped lookup getById uses below, so an out-of-scope delete
    // is refused by this gateway even though the underlying service alone
    // wouldn't catch it.
    delete: (id, tenantId, scope, ...guard) => deleteTeamScoped(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getTeamByIdScoped(id, tenantId, scope),
    // managerUserId decides which manager sees the team's records
    // (DataScope), so the assistant reads it but never writes it
    // (crm-read.service.ts's SCHEMA_FIELD_WRITE_EXCLUSIONS, D28).
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'managerUserId', label: 'Manager', type: 'text' }],
  },
  // Field Service's own "Customer" (NativeCustomer, collection
  // native_customers) — the billing customer WorkOrder/Invoice/Quotation
  // actually reference. Distinct from Company (native_companies) and from
  // the omnichannel Customer/CrmContact models the prompt's crmContext
  // block already covers — see the "never merge counts across sources"
  // rule in system.prompts.ts. Also has mobile-app customer-portal
  // credentials (appUsername/appPasswordHash/appPasswordEnc), same
  // select:false + allowlist-exclusion pattern as Staff below.
  customer: {
    permissionPrefix: 'fs.customers', logModule: 'customers', statusField: 'status',
    label: 'Customers', flagKey: 'fs_customers', statusFilter: { kind: 'enum', model: NativeCustomer, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listCustomers(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    // getCustomerById/updateCustomer/deleteCustomer are already correctly
    // scoped internally (applyDataScopeToFilter(..., 'assignedStaffId')),
    // confirmed by reading customer.service.ts directly — no adapter
    // needed. deleteCustomer also already enforces real referential
    // integrity (blocks with a 409 if the customer has linked Quotations/
    // WorkOrders/Invoices/Receipts/Contracts) — reused as-is.
    create: (tenantId, data) => createCustomer({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateCustomer(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteCustomer(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getCustomerById(id, tenantId, scope),
    // getCustomerStats takes branchId as an optional TRAILING parameter
    // (only this gateway passes it), so the assistant's customer stats use
    // the same branch as its customer list/count.
    stats: (tenantId, branchId, scope, range, customFrom, customTo) => getCustomerStats(tenantId, scope, range, customFrom, customTo, branchId),
    schemaFields: [
      // customerId: the human-readable business id (e.g. "CUS-0001") — NOT
      // a credential, and required by crm-customer-lookup.tool.ts's
      // existing Phase 1 flow ("create a work order for Kumar" resolves a
      // real customerId from this exact field before proposing the write).
      { key: 'customerId', label: 'Customer ID', type: 'text' },
      { key: 'name', label: 'Name', type: 'text' }, { key: 'company', label: 'Company', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'country', label: 'Country', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  // Staff: schemaFields deliberately excludes appUsername/appPasswordHash/
  // appPasswordEnc/appCredentialsGeneratedAt/appLastLoginAt — the mobile-app
  // login credential fields — even though appPasswordHash/appPasswordEnc
  // already carry Mongoose `select:false` (confirmed in staff.model.ts, so
  // they're excluded from query results by default regardless). This
  // allowlist is a second, independent layer: the chatbot is never even
  // told these fields exist, so it can't ask for them even if a future
  // change to listStaffs() ever selected them explicitly.
  staff: {
    permissionPrefix: 'fs.staffs', logModule: 'staffs', statusField: 'status',
    label: 'Staff', flagKey: 'fs_staffs', statusFilter: { kind: 'enum', model: NativeStaff, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listStaffs(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    // createStaff auto-provisions mobile-app login credentials as a side
    // effect (ensureCredentials) — pre-existing, never blocks/breaks
    // creation, confirmed in staff.service.ts. updateStaff already scopes
    // itself correctly; deleteStaff does not (same gap as Team), gated the
    // same way via deleteStaffScoped.
    create: (tenantId, data) => createStaff({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateStaff(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteStaffScoped(id, tenantId, scope, ...guard),
    getById: (id, tenantId, scope) => getStaffByIdScoped(id, tenantId, scope),
    // teamId decides which team manager sees this staff member's records
    // (DataScope): read, never written by the assistant
    // (SCHEMA_FIELD_WRITE_EXCLUSIONS, D28).
    schemaFields: [
      { key: 'firstName', label: 'First Name', type: 'text' }, { key: 'lastName', label: 'Last Name', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'teamId', label: 'Team', type: 'text' }, { key: 'role', label: 'Role', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'onleave', label: 'On Leave' }] },
    ],
  },

  // ── Deals, Contacts, Activities (full CRUD) and Supervisors (read-only) ─
  // Deal (native_crm.deals.*, flag native_deals — the same flag/route the
  // sidebar's Field Service "Deals" item uses). tenantId-first service
  // signatures, like Company. `stage` is a tenant pipeline stage
  // (isValidStageKey in createDeal/updateDeal). Schema comes from
  // getFieldCatalog('deal'). No date filter, no overdue, and deliberately no
  // stats: getDealStats' `total` counts OPEN deals in a date range only.
  deal: {
    permissionPrefix: 'native_crm.deals', logModule: 'deals', statusField: 'stage',
    label: 'Deals', flagKey: 'native_deals', statusFilter: { kind: 'pipeline', pipelineModule: 'deal' },
    readFields: DEAL_READ_FIELDS,
    requiresVersionToken: true,
    list: (tenantId, opts, branchId, scope) => listDeals(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createDeal(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateDeal(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope, ...guard) => deleteDeal(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getDealById(tenantId, id, scope),
  },
  // Native CRM Contact (crm_contacts). PII (email/phone) is decrypted or
  // masked through the 'contacts' PII path. deleteContact refuses (409) when
  // deals or leads are linked; it returns a boolean, like deleteCompany.
  contact: {
    permissionPrefix: 'native_crm.contacts', logModule: 'contacts', statusField: 'status',
    label: 'Contacts', flagKey: 'native_contacts', statusFilter: { kind: 'enum', model: Contact, field: 'status' },
    requiresVersionToken: true,
    list: (tenantId, opts, branchId, scope, userId) => listContacts(tenantId, opts as any, branchId, scope, userId),
    create: (tenantId, data) => createContact(tenantId, assertContactEmail(data, true) as any),
    update: (id, tenantId, data, scope) => updateContact(tenantId, id, assertContactEmail(data, false) as any, scope),
    delete: (id, tenantId, scope, ...guard) => deleteContact(tenantId, id, scope, ...guard),
    getById: (id, tenantId, scope) => getContactById(tenantId, id, scope),
    // Reads only (GET /crm-get): the caller's owner values are looked up when
    // the read runs. update, delete and getById above stay ids only.
    forCaller: (userId) => ({
      getById: async (id, tenantId, scope) => getContactById(tenantId, id, scope, await contactOwnerValues(userId)),
    }),
    // getContactStats(tenantId, scope) — {total, byStatus}; no branch/range.
    stats: (tenantId, _branchId, scope) => getContactStats(tenantId, scope),
    schemaFields: [
      { key: 'firstName', label: 'First Name', type: 'text' }, { key: 'lastName', label: 'Last Name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'company', label: 'Company', type: 'text' }, { key: 'jobTitle', label: 'Job Title', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'lead', label: 'Lead' }, { value: 'contact', label: 'Contact' }, { value: 'customer', label: 'Customer' }] },
      { key: 'source', label: 'Source', type: 'select', options: ['website', 'referral', 'social', 'email', 'cold', 'other'].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })) },
    ],
  },
  // Field Service Activity (native_activities). activityId is the
  // server-generated business id: readable, never writable.
  activity: {
    permissionPrefix: 'fs.activities', logModule: 'activities', statusField: 'status',
    label: 'Activities', flagKey: 'fs_activities', statusFilter: { kind: 'enum', model: NativeActivity, field: 'status' },
    list: (tenantId, opts, branchId, scope) => listActivities(tenantId, withEscapedSearch(opts) as any, branchId, scope),
    create: (tenantId, data) => createActivity({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateActivity(id, tenantId, data, scope, ...guard),
    delete: (id, tenantId, scope, ...guard) => deleteActivity(id, tenantId, scope, ...guard),
    // A malformed id would throw a CastError (500) — treat it as not found.
    getById: async (id, tenantId, scope) => (mongoose.isValidObjectId(id) ? getActivityById(id, tenantId, scope) : null),
    schemaFields: [
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'type', label: 'Type', type: 'select', options: ['note', 'call', 'email', 'visit', 'task'].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })) },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'pending', label: 'Pending' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }] },
      { key: 'scheduledAt', label: 'Scheduled At', type: 'date' }, { key: 'completedAt', label: 'Completed At', type: 'date' },
      { key: 'assignedTo', label: 'Assigned To', type: 'text' }, { key: 'description', label: 'Description', type: 'text' },
      { key: 'relatedModule', label: 'Related Module', type: 'text' }, { key: 'relatedId', label: 'Related Record', type: 'text' },
      { key: 'activityId', label: 'Activity ID', type: 'text' },
    ],
  },
  // Supervisor — READ-ONLY. Not a model of its own: a User with role
  // MANAGER that is not deactivated (supervisor-read.service.ts), listed
  // tenant-wide like the sidebar and SupervisorsPage. View permission is the
  // one the Users list requires (users.view); flag fs_supervisors. No
  // create/update/delete/stats/status. schemaFields is the complete list of
  // what can ever leave the gateway — never a password, token or credential
  // (the service doesn't even read them). Email is masked through the
  // 'users' PII path.
  supervisor: {
    permissionPrefix: 'users', logModule: 'users',
    label: 'Supervisors', flagKey: 'fs_supervisors', statusFilter: { kind: 'none' },
    list: (tenantId, opts) => listSupervisors(tenantId, opts),
    getById: (id, tenantId) => getSupervisorById(id, tenantId),
    schemaFields: [
      { key: 'firstName', label: 'First Name', type: 'text' }, { key: 'lastName', label: 'Last Name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' }, { key: 'teamNames', label: 'Teams Managed', type: 'text' },
    ],
  },

  // ── Field Service documents (Increment 5; quotation writes Increment 7) ──
  // Quotations, contracts and receipts can be listed, counted and read.
  // Quotations are created and changed only through the assistant's guided
  // form (Increment 7): its Confirm calls the create and update below, and
  // /crm-write refuses both (internal.routes.ts). There is no quotation
  // delete (D20). Contracts and receipts stay read-only (D7): no
  // create/update/delete, so /crm-write and the assistant's staged operations
  // refuse every change to them. Flags, permission prefixes and log modules
  // are their screens' own (native-crm.router.ts, *.routes.ts,
  // native-crm-log.middleware.ts). Each list() compiles the raw search text
  // (quotation, contract: title and customerId; receipt: receiptId, invoiceId
  // and customerId), so the closures escape it. getById matches the _id or
  // the business number under the caller's scope, without the branch (as
  // getInvoiceById does). No stats and no overdue: none of the three
  // services has them.
  quotation: {
    permissionPrefix: 'fs.quotations', logModule: 'quotations', statusField: 'status',
    label: 'Quotations', flagKey: 'fs_quotations',
    // Stages from the tenant's quotation pipeline (draft, sent, approved, rejected by default).
    statusFilter: { kind: 'pipeline', pipelineModule: 'quotation' },
    dateFilter: { defaultField: 'createdAt', fields: ['validUntil', 'createdAt'] },
    readFields: QUOTATION_READ_FIELDS,
    // The invoice's shape: the guard reaches updateQuotation only when given.
    create: (tenantId, data) => createQuotation({ ...data, tenantId }),
    update: (id, tenantId, data, scope, ...guard) => updateQuotation(id, tenantId, data, scope, ...guard),
    getById: (id, tenantId, scope) => getQuotationById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listQuotations(tenantId, withEscapedSearch(opts) as any, branchId, scope),
  },
  contract: {
    permissionPrefix: 'fs.contracts', logModule: 'contracts', statusField: 'status',
    label: 'Contracts', flagKey: 'fs_contracts',
    statusFilter: { kind: 'pipeline', pipelineModule: 'contract' },
    dateFilter: { defaultField: 'startDate', fields: ['startDate', 'endDate', 'createdAt'] },
    readFields: CONTRACT_READ_FIELDS,
    getById: (id, tenantId, scope) => getContractById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listContracts(tenantId, withEscapedSearch(opts) as any, branchId, scope),
  },
  // Receipt status is a fixed schema enum (pending, completed, refunded), and
  // listReceipts takes no date range, so a date filter is refused.
  receipt: {
    permissionPrefix: 'fs.receipts', logModule: 'receipts', statusField: 'status',
    label: 'Receipts', flagKey: 'fs_receipts',
    statusFilter: { kind: 'enum', model: NativeReceipt, field: 'status' },
    readFields: RECEIPT_READ_FIELDS,
    getById: (id, tenantId, scope) => getReceiptById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listReceipts(tenantId, withEscapedSearch(opts) as any, branchId, scope),
  },
};
