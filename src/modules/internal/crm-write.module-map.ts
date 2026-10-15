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
import { listMeetings, getMeetingStats } from '../native-crm/meetings/meeting.service';
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
import { DataScope } from '../../types';
import { applyDataScopeToFilter, applyDataScopeToTeamFilter } from '../native-crm/shared/data-scope';
import { ITargetFieldDef } from '../native-crm/automation-rules/target-field-catalog';
import { Model } from 'mongoose';
import mongoose from 'mongoose';

export type CrmWriteOperation = 'create' | 'update' | 'delete' | 'view';

export interface CrmWriteModuleDef {
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
  update?: (id: string, tenantId: string, data: Record<string, unknown>, scope?: DataScope) => Promise<any>;
  delete?: (id: string, tenantId: string, scope?: DataScope) => Promise<any>;
  /** Single-record fetch by real _id — used by GET /crm-get (builds an
   * update/delete confirmation's before-snapshot/diff) and by POST
   * /crm-write's stale-check (re-fetches immediately before dispatching an
   * update/delete, comparing against the proposal-time snapshot). Optional:
   * undefined for any module without create/update/delete populated. */
  getById?: (id: string, tenantId: string, scope?: DataScope) => Promise<any>;
  /** Read — used by GET /crm-list/:tenantId/:module (search/list) AND, as
   * of Stage A, GET /crm-count/:tenantId/:module (calls this with
   * {limit:1} and reads .total) — deliberately the SAME function the
   * module's own human-facing list screen already calls, so a chatbot
   * count can never silently diverge from whatever filtering (active/
   * archived/branch/etc.) that screen already applies. No separate
   * countDocuments reimplementation exists in this file. */
  list: (tenantId: string, opts: { search?: string; limit?: number; page?: number }, branchId?: string | null, scope?: DataScope) => Promise<{ items: any[]; total: number }>;
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
 * These wrappers add the same scoping those list functions already use
 * (applyDataScopeToTeamFilter / applyDataScopeToFilter(..., 'staffId'))
 * directly against the model, so `getById` is scoped everywhere it's
 * consulted — not just at delete time. */
async function getTeamByIdScoped(id: string, tenantId: string, scope?: DataScope): Promise<any> {
  const filter: Record<string, unknown> = { _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) };
  applyDataScopeToTeamFilter(filter, scope);
  return NativeTeam.findOne(filter);
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
 * second, divergent scoping implementation. */
async function deleteTeamScoped(id: string, tenantId: string, scope?: DataScope): Promise<any> {
  const existing = await getTeamByIdScoped(id, tenantId, scope);
  if (!existing) return null;
  return deleteTeam(id, tenantId);
}

async function deleteStaffScoped(id: string, tenantId: string, scope?: DataScope): Promise<any> {
  const existing = await getStaffByIdScoped(id, tenantId, scope);
  if (!existing) return null;
  return deleteStaff(id, tenantId);
}

/** The module capability registry — the single authoritative allowlist of
 * what the CRM chatbot can see/touch. POST /crm-write, GET /crm-list, GET
 * /crm-count, GET /crm-overdue, and GET /crm-schema (internal.routes.ts)
 * all reject any :module not listed here before doing anything else.
 * Extend this (Stage B) to add write support to a module already listed
 * here for read; the gateway's own dispatch logic never needs to change to
 * support a new module, only this map. */
export const CRM_WRITE_MODULE_MAP: Record<string, CrmWriteModuleDef> = {
  // ── Phase 1 — full CRUD, already live-verified ──────────────────────────
  lead: {
    permissionPrefix: 'native_crm.leads',
    logModule: 'leads',
    create: (tenantId, data) => createLead({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateLead(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteLead(id, tenantId, scope),
    getById: (id, tenantId, scope) => getLeadById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listLeads(tenantId, opts as any, branchId, scope),
  },
  workorder: {
    permissionPrefix: 'fs.workorders',
    logModule: 'workorders',
    create: (tenantId, data) => createWorkorder({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateWorkorder(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteWorkorder(id, tenantId, scope),
    getById: (id, tenantId, scope) => getWorkorderById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listWorkorders(tenantId, opts as any, branchId, scope),
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
    create: (tenantId, data) => createInvoice({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateInvoice(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteInvoice(id, tenantId, scope),
    getById: (id, tenantId, scope) => getInvoiceById(id, tenantId, scope),
    list: (tenantId, opts, branchId, scope) => listInvoices(tenantId, opts as any, branchId, scope),
  },

  // ── Stage B increment 1 — full CRUD, live-verified ──────────────────────
  category: {
    permissionPrefix: 'fs.categories', logModule: 'categories', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listCategories(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createCategory({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateCategory(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteCategory(id, tenantId, scope),
    getById: (id, tenantId, scope) => getCategoryById(id, tenantId, scope),
    schemaFields: STATUS_FIELD_ALLOWLIST,
  },
  service: {
    permissionPrefix: 'fs.services', logModule: 'services', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listServices(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createService({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateService(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteService(id, tenantId, scope),
    getById: (id, tenantId, scope) => getServiceById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'categoryId', label: 'Category', type: 'text' }, { key: 'price', label: 'Price', type: 'number' }, { key: 'duration', label: 'Duration', type: 'number' }],
  },
  part: {
    permissionPrefix: 'fs.parts', logModule: 'parts', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listParts(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createPart({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updatePart(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deletePart(id, tenantId, scope),
    getById: (id, tenantId, scope) => getPartById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'partNumber', label: 'Part Number', type: 'text' }, { key: 'price', label: 'Price', type: 'number' }, { key: 'quantity', label: 'Quantity', type: 'number' }],
  },
  product: {
    permissionPrefix: 'fs.products', logModule: 'products', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listProducts(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createProduct({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateProduct(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteProduct(id, tenantId, scope),
    getById: (id, tenantId, scope) => getProductById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'sku', label: 'SKU', type: 'text' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'sellingPrice', label: 'Selling Price', type: 'number' }, { key: 'stock', label: 'Stock', type: 'number' }],
  },
  asset: {
    permissionPrefix: 'fs.assets', logModule: 'assets', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listAssets(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createAsset({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateAsset(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteAsset(id, tenantId, scope),
    getById: (id, tenantId, scope) => getAssetById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'serialNumber', label: 'Serial Number', type: 'text' }, { key: 'purchaseDate', label: 'Purchase Date', type: 'date' }, { key: 'warrantyExpiry', label: 'Warranty Expiry', type: 'date' }, { key: 'condition', label: 'Condition', type: 'select', options: [{ value: 'new', label: 'New' }, { value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Poor' }] }],
  },
  vehicle: {
    permissionPrefix: 'fs.vehicles', logModule: 'vehicles', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listVehicles(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createVehicle({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateVehicle(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteVehicle(id, tenantId, scope),
    getById: (id, tenantId, scope) => getVehicleById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'registrationNumber', label: 'Registration Number', type: 'text' }, { key: 'make', label: 'Make', type: 'text' }, { key: 'lastServiceDate', label: 'Last Service Date', type: 'date' }],
  },
  expense: {
    permissionPrefix: 'fs.expenses', logModule: 'expenses', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listExpenses(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createExpense({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateExpense(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteExpense(id, tenantId, scope),
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
    list: (tenantId, opts, branchId, scope) => listCompanies(tenantId, opts as any, scope, undefined) as any,
    create: (tenantId, data) => createCompany(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateCompany(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope) => deleteCompany(tenantId, id, scope),
    getById: (id, tenantId, scope) => getCompanyById(tenantId, id, scope),
    // getCompanyStats(tenantId, scope?) — no branchId/range params, unlike
    // workorder/task/ticket's stats functions; the wrapper just drops what
    // this one doesn't accept.
    stats: (tenantId, _branchId, scope) => getCompanyStats(tenantId, scope),
    schemaFields: [
      { key: 'name', label: 'Name', type: 'text' }, { key: 'domain', label: 'Domain', type: 'text' }, { key: 'industry', label: 'Industry', type: 'text' }, { key: 'employeeCount', label: 'Employee Count', type: 'number' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'country', label: 'Country', type: 'text' },
      { key: 'companyStatus', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'prospect', label: 'Prospect' }] },
    ],
  },
  task: {
    permissionPrefix: 'native_crm.tasks', logModule: 'tasks', statusField: 'taskStatus',
    list: (tenantId, opts, branchId, scope) => listTasks(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createTask(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateTask(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope) => deleteTask(tenantId, id, scope),
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
    list: (tenantId, opts, branchId, scope) => listTickets(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createTicket(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateTicket(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope) => deleteTicket(tenantId, id, scope),
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
    list: (tenantId, opts, branchId, scope) => listCalls(tenantId, opts as any, scope, undefined) as any,
    create: (tenantId, data) => createCall(tenantId, data as any),
    update: (id, tenantId, data, scope) => updateCall(tenantId, id, data as any, scope),
    delete: (id, tenantId, scope) => deleteCall(tenantId, id, scope),
    getById: (id, tenantId, scope) => getCallById(tenantId, id, scope),
    stats: (tenantId, _branchId, scope) => getCallStats(tenantId, scope),
    schemaFields: [
      { key: 'contactName', label: 'Contact Name', type: 'text' }, { key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }] }, { key: 'duration', label: 'Duration (seconds)', type: 'number' }, { key: 'date', label: 'Date', type: 'date' },
      { key: 'callStatus', label: 'Status', type: 'select', options: [{ value: 'planned', label: 'Planned' }, { value: 'completed', label: 'Completed' }, { value: 'missed', label: 'Missed' }, { value: 'cancelled', label: 'Cancelled' }] },
    ],
  },
  meeting: {
    permissionPrefix: 'native_crm.meetings', logModule: 'meetings', statusField: 'meetingStatus',
    list: (tenantId, opts, branchId, scope) => listMeetings(tenantId, opts as any, scope, undefined) as any,
    stats: (tenantId, _branchId, scope) => getMeetingStats(tenantId, scope),
    schemaFields: [
      { key: 'title', label: 'Title', type: 'text' }, { key: 'startDate', label: 'Start Date', type: 'date' }, { key: 'endDate', label: 'End Date', type: 'date' }, { key: 'location', label: 'Location', type: 'text' }, { key: 'assignedStaffId', label: 'Assigned Staff', type: 'text' },
      { key: 'meetingStatus', label: 'Status', type: 'select', options: [{ value: 'scheduled', label: 'Scheduled' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }] },
    ],
  },
  site: {
    permissionPrefix: 'fs.sites', logModule: 'sites', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listSites(tenantId, opts as any, branchId, scope),
    create: async (tenantId, data) => createSite({ ...(await resolveSiteCustomerId(tenantId, data)), tenantId }),
    update: async (id, tenantId, data, scope) => updateSite(id, tenantId, await resolveSiteCustomerId(tenantId, data), scope),
    delete: (id, tenantId, scope) => deleteSite(id, tenantId, scope),
    getById: (id, tenantId, scope) => getSiteById(id, tenantId, scope),
    schemaFields: [...STATUS_FIELD_ALLOWLIST, { key: 'address', label: 'Address', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'customerId', label: 'Customer', type: 'text' }, { key: 'contactPerson', label: 'Contact Person', type: 'text' }],
  },
  team: {
    permissionPrefix: 'fs.teams', logModule: 'teams', statusField: 'status',
    list: (tenantId, opts, branchId, scope) => listTeams(tenantId, opts as any, branchId, scope),
    create: (tenantId, data) => createTeam({ ...data, tenantId }),
    // updateTeam already enforces its own scope check internally
    // (scope.teamIds.includes(id)) — reused as-is, not duplicated here.
    update: (id, tenantId, data, scope) => updateTeam(id, tenantId, data, scope),
    // deleteTeam itself has no scope param — deleteTeamScoped gates it with
    // the same scoped lookup getById uses below, so an out-of-scope delete
    // is refused by this gateway even though the underlying service alone
    // wouldn't catch it.
    delete: (id, tenantId, scope) => deleteTeamScoped(id, tenantId, scope),
    getById: (id, tenantId, scope) => getTeamByIdScoped(id, tenantId, scope),
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
    list: (tenantId, opts, branchId, scope) => listCustomers(tenantId, opts as any, branchId, scope),
    // getCustomerById/updateCustomer/deleteCustomer are already correctly
    // scoped internally (applyDataScopeToFilter(..., 'assignedStaffId')),
    // confirmed by reading customer.service.ts directly — no adapter
    // needed. deleteCustomer also already enforces real referential
    // integrity (blocks with a 409 if the customer has linked Quotations/
    // WorkOrders/Invoices/Receipts/Contracts) — reused as-is.
    create: (tenantId, data) => createCustomer({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateCustomer(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteCustomer(id, tenantId, scope),
    getById: (id, tenantId, scope) => getCustomerById(id, tenantId, scope),
    // getCustomerStats(tenantId, scope?, range?, customFrom?, customTo?) —
    // no branchId param, unlike workorder/task/ticket's stats functions.
    stats: (tenantId, _branchId, scope, range, customFrom, customTo) => getCustomerStats(tenantId, scope, range, customFrom, customTo),
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
    list: (tenantId, opts, branchId, scope) => listStaffs(tenantId, opts as any, branchId, scope),
    // createStaff auto-provisions mobile-app login credentials as a side
    // effect (ensureCredentials) — pre-existing, never blocks/breaks
    // creation, confirmed in staff.service.ts. updateStaff already scopes
    // itself correctly; deleteStaff does not (same gap as Team), gated the
    // same way via deleteStaffScoped.
    create: (tenantId, data) => createStaff({ ...data, tenantId }),
    update: (id, tenantId, data, scope) => updateStaff(id, tenantId, data, scope),
    delete: (id, tenantId, scope) => deleteStaffScoped(id, tenantId, scope),
    getById: (id, tenantId, scope) => getStaffByIdScoped(id, tenantId, scope),
    schemaFields: [
      { key: 'firstName', label: 'First Name', type: 'text' }, { key: 'lastName', label: 'Last Name', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'teamId', label: 'Team', type: 'text' }, { key: 'role', label: 'Role', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'onleave', label: 'On Leave' }] },
    ],
  },
};
