import type { FieldCap, FieldKind, ModuleCap } from './types';
import { ROUTE_TEMPLATES } from '../contracts/routes';
import { Lead } from '../../native-crm/leads/lead.model';
import { NativeWorkorder } from '../../native-crm/workorders/workorder.model';
import { NativeInvoice } from '../../native-crm/invoices/invoice.model';
import { NativeCategory } from '../../native-crm/categories/category.model';
import { NativeService } from '../../native-crm/services/service.model';
import { NativePart } from '../../native-crm/parts/part.model';
import { NativeProduct } from '../../native-crm/products/product.model';
import { NativeAsset } from '../../native-crm/assets/asset.model';
import { NativeVehicle } from '../../native-crm/vehicles/vehicle.model';
import { NativeExpense } from '../../native-crm/expenses/expense.model';
import { NativeSite } from '../../native-crm/sites/site.model';
import { NativeTeam } from '../../native-crm/teams/team.model';
import { NativeStaff } from '../../native-crm/staffs/staff.model';
import { NativeCustomer } from '../../native-crm/customers/customer.model';
import { Deal } from '../../native-crm/deals/deal.model';
import { NativeActivity } from '../../native-crm/activities/activity.model';
import { User } from '../../auth/auth.model';

/* Modules the sidebar shows under "Field Service" (ai/src/tools/crm/
 * module-map.ts crmSourceFor), including Leads and Deals (decision D2).
 *
 * Tiers: 'list' and 'detail' fields are only ever ones the gateway's read
 * projection keeps (crm-read.service.ts readFieldKeysFor: the module map's
 * readFields or schemaFields), so nothing here can widen what leaves the
 * gateway. 'hidden' fields drive the engine (business numbers the projection
 * drops, owner fields for "mine", creation dates) and are never shown.
 * Every other schema path is listed in ignoredPaths with its reason; the
 * drift test fails when a model gains a path nobody has classified. */

type Read = FieldCap['read'];
type Ignored = ModuleCap['ignoredPaths'];

const f = (path: string, label: string, kind: FieldKind, read: Read, extra: Partial<FieldCap> = {}): FieldCap =>
  ({ key: path, path, label, kind, read, ...extra });
const col = (priority: 1 | 2 | 3): Partial<FieldCap> => ({ priority });
const created = (read: Read): FieldCap => f('createdAt', 'Created', 'datetime', read, { dateRule: 'instant' });
const updated = (): FieldCap => f('updatedAt', 'Updated', 'datetime', 'detail', { dateRule: 'instant' });
const branchMoney: Partial<FieldCap> = { money: { currency: 'fs_branch' } };
const fromSchema: Partial<FieldCap> = { enumFrom: 'schema' };

/** Paths every Field Service model carries that are never offered. */
const BASE: Ignored = {
  _id: 'system', __v: 'system', tenantId: 'system', branchId: 'system', clientId: 'internal', numId: 'internal',
  createdBy: 'system', customFields: 'detail_only',
};
const LOCKS: Ignored = { isLocked: 'system', lockedAt: 'system', lockedBy: 'system', lockReason: 'system' };
const SEARCH_INDEXES: Ignored = { phoneSearch: 'secret', emailDomain: 'secret', emailSearch: 'secret' };
const APP_LOGIN: Ignored = {
  appUsername: 'secret', appPasswordHash: 'secret', appPasswordEnc: 'secret',
  appCredentialsGeneratedAt: 'secret', appLastLoginAt: 'secret',
};

const lead: ModuleCap = {
  key: 'lead',
  group: 'field_service',
  labels: {
    singular: 'Lead', plural: 'Leads',
    synonyms: ['lead', 'leads', 'sales lead', 'sales leads', 'enquiry', 'enquiries', 'inquiry', 'inquiries'],
  },
  gate: { flagKey: 'fs_leads', permPrefix: 'native_crm.leads', scopeKey: 'leads' },
  model: () => Lead,
  ids: { business: 'leadId', businessUnique: false, title: ['firstName lastName', 'company'] },
  stage: { field: 'status', pipeline: 'lead' },
  dates: { default: 'createdAt', created: 'createdAt', due: 'expectedCloseDate' },
  mine: { kind: 'owner_ids', field: 'leadOwnerStaffId', match: ['userId', 'ownStaffId'] },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: {
    default: { by: 'lastActivityAt', dir: 'desc' },
    listSortable: [
      'leadId', 'firstName', 'lastName', 'company', 'status', 'source', 'rating', 'score', 'priority', 'leadOwner',
      'expectedRevenue', 'expectedCloseDate', 'createdAt', 'updatedAt',
    ],
  },
  fields: [
    f('firstName', 'First name', 'text', 'list', col(1)),
    f('lastName', 'Last name', 'text', 'list', col(1)),
    f('status', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'lead' } }),
    f('leadId', 'Lead ID', 'id', 'list', col(2)),
    f('company', 'Company', 'text', 'list', col(2)),
    f('leadOwner', 'Owner', 'text', 'list', col(3)),
    f('designation', 'Designation', 'text', 'detail'),
    f('email', 'Email', 'email', 'detail', { pii: { module: 'leads', encrypted: true, blindIndex: 'emailSearch' } }),
    f('phone', 'Phone', 'phone', 'detail', { pii: { module: 'leads', encrypted: true, blindIndex: 'phoneSearch' } }),
    f('mobile', 'Mobile', 'phone', 'detail', { pii: { module: 'leads', encrypted: true, blindIndex: 'phoneSearch' } }),
    f('source', 'Source', 'enum', 'detail', fromSchema),
    f('rating', 'Rating', 'enum', 'detail', fromSchema),
    f('score', 'Score', 'number', 'detail'),
    f('priority', 'Priority', 'enum', 'detail', fromSchema),
    f('teamName', 'Team', 'text', 'detail'),
    f('city', 'City', 'text', 'detail'),
    f('state', 'State', 'text', 'detail'),
    f('country', 'Country', 'text', 'detail'),
    f('expectedRevenue', 'Expected revenue', 'money', 'detail', branchMoney),
    f('expectedCloseDate', 'Expected close date', 'date', 'detail', { dateRule: 'date' }),
    f('isConverted', 'Converted', 'boolean', 'detail'),
    created('detail'),
    updated(),
    f('leadOwnerStaffId', 'Owner staff ID', 'text', 'hidden'),
    // list()'s default sort (then createdAt); not in the read projection.
    f('lastActivityAt', 'Last activity', 'datetime', 'hidden', { dateRule: 'instant' }),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS, ...SEARCH_INDEXES,
    industry: 'detail_only', website: 'detail_only', gstNumber: 'detail_only', annualRevenue: 'detail_only',
    employeeCount: 'detail_only', secondaryEmail: 'detail_only', whatsapp: 'detail_only', alternatePhone: 'detail_only',
    linkedin: 'detail_only', facebook: 'detail_only', twitter: 'detail_only', address: 'detail_only',
    address2: 'detail_only', postalCode: 'detail_only', teamId: 'internal', budget: 'detail_only',
    interestedProducts: 'detail_only', interestedServices: 'detail_only', interestedItems: 'detail_only',
    conversationSummary: 'internal', chatSessionId: 'internal', sourceUrl: 'internal',
    competitor: 'detail_only', requirement: 'detail_only', painPoints: 'detail_only', decisionMaker: 'detail_only',
    purchaseTimeline: 'detail_only', lostReason: 'detail_only', campaign: 'detail_only',
    utmSource: 'internal', utmMedium: 'internal', utmCampaign: 'internal', googleAdsId: 'internal',
    facebookCampaign: 'internal', landingPage: 'internal',
    convertedCustomerId: 'detail_only', convertedAt: 'detail_only', contactId: 'detail_only', opportunityId: 'detail_only',
    conversionHistory: 'internal', tags: 'detail_only', notes: 'detail_only',
    importBatchId: 'internal',
  },
  routes: ROUTE_TEMPLATES.lead,
};

const workorder: ModuleCap = {
  key: 'workorder',
  group: 'field_service',
  labels: {
    singular: 'Work Order', plural: 'Work Orders',
    synonyms: [
      'work order', 'work orders', 'workorder', 'workorders', 'wo', 'wos', 'job', 'jobs', 'service job', 'service jobs',
    ],
  },
  gate: { flagKey: 'fs_workorders', permPrefix: 'fs.workorders', scopeKey: 'workorders' },
  model: () => NativeWorkorder,
  ids: { business: 'workOrderId', businessUnique: false, title: ['title'] },
  stage: { field: 'status', pipeline: 'workorder' },
  dates: { default: 'scheduledDate', created: 'createdAt', due: 'scheduledDate', start: 'scheduledDate' },
  mine: { kind: 'staff_array', field: 'staffIds' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('status', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'workorder' } }),
    f('workOrderId', 'Work order ID', 'id', 'list', col(2)),
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ref: { module: 'customer', targetField: 'customerId', idFormat: 'business' } }),
    f('scheduledDate', 'Scheduled', 'datetime', 'list', { ...col(2), dateRule: 'instantOrMidnight' }),
    f('priority', 'Priority', 'enum', 'list', { ...col(3), ...fromSchema }),
    f('siteId', 'Site', 'ref', 'detail', { ref: { module: 'site', targetField: 'siteId', idFormat: 'business' } }),
    f('teamId', 'Team', 'ref', 'detail', { ref: { module: 'team', targetField: 'teamId', idFormat: 'business' } }),
    f('staffIds', 'Assigned staff', 'ref_many', 'detail', { ref: { module: 'staff', targetField: 'staffId', idFormat: 'business' } }),
    f('completedDate', 'Completed', 'datetime', 'detail', { dateRule: 'instant' }),
    f('durationHours', 'Duration', 'duration', 'detail', { unit: 'hours' }),
    f('discount', 'Discount', 'percent', 'detail'),
    f('gstPercentage', 'GST', 'percent', 'detail'),
    f('quotationId', 'Quotation', 'text', 'detail'),
    f('contractId', 'Contract', 'text', 'detail'),
    f('contractVisitNumber', 'Contract visit', 'number', 'detail'),
    created('detail'),
    updated(),
    f('staffId', 'Lead staff', 'ref', 'hidden', { ref: { module: 'staff', targetField: 'staffId', idFormat: 'business' } }),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS,
    address: 'detail_only', services: 'detail_only', parts: 'detail_only', notes: 'detail_only',
    termsAndConditions: 'detail_only', checklists: 'detail_only', photos: 'internal', signatureUrl: 'secret',
    skills: 'detail_only', workflowState: 'internal', portalToken: 'secret',
  },
  routes: ROUTE_TEMPLATES.workorder,
};

const invoice: ModuleCap = {
  key: 'invoice',
  group: 'field_service',
  labels: { singular: 'Invoice', plural: 'Invoices', synonyms: ['invoice', 'invoices'] },
  gate: { flagKey: 'fs_invoices', permPrefix: 'fs.invoices', scopeKey: 'invoices' },
  model: () => NativeInvoice,
  ids: { business: 'invoiceId', businessUnique: false, title: ['invoiceId'] },
  stage: { field: 'status', pipeline: 'invoice' },
  dates: { default: 'dueDate', created: 'createdAt', due: 'dueDate' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('invoiceId', 'Invoice', 'id', 'list', col(1)),
    f('status', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'invoice' } }),
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ref: { module: 'customer', targetField: 'customerId', idFormat: 'business' } }),
    f('servicesAmountWithTax', 'Total', 'money', 'list', { ...col(2), ...branchMoney }),
    f('dueDate', 'Due', 'date', 'list', { ...col(2), dateRule: 'date' }),
    f('balanceDue', 'Balance due', 'money', 'list', { ...col(3), ...branchMoney, virtual: true }),
    f('workOrderId', 'Work order', 'ref', 'detail', { ref: { module: 'workorder', targetField: 'workOrderId', idFormat: 'business' } }),
    f('quotationId', 'Quotation', 'text', 'detail'),
    f('contractId', 'Contract', 'text', 'detail'),
    f('paid', 'Paid', 'boolean', 'detail'),
    f('paidAmount', 'Paid amount', 'money', 'detail', branchMoney),
    f('servicesAmount', 'Subtotal', 'money', 'detail', branchMoney),
    f('partsAmount', 'Parts amount', 'money', 'detail', branchMoney),
    f('discount', 'Discount', 'percent', 'detail'),
    f('gstPercentage', 'GST', 'percent', 'detail'),
    created('detail'),
    updated(),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS,
    address: 'detail_only', services: 'detail_only', parts: 'detail_only', priorStatus: 'internal',
    notes: 'detail_only', termsAndConditions: 'detail_only', workflowState: 'internal', portalToken: 'secret',
    // LR-PL-INV-001: the hold on the work order, set by the invoice service only.
    workOrderLock: 'system',
  },
  routes: ROUTE_TEMPLATES.invoice,
};

const category: ModuleCap = {
  key: 'category',
  group: 'field_service',
  labels: {
    singular: 'Category', plural: 'Categories',
    synonyms: ['category', 'categories', 'service category', 'service categories'],
  },
  gate: { flagKey: 'fs_categories', permPrefix: 'fs.categories', scopeKey: 'categories' },
  model: () => NativeCategory,
  ids: { business: 'categoryId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('description', 'Description', 'longtext', 'list', col(2)),
    f('categoryId', 'Category ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, color: 'detail_only', icon: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.category,
};

const service: ModuleCap = {
  key: 'service',
  group: 'field_service',
  labels: { singular: 'Service', plural: 'Services', synonyms: ['service', 'services'] },
  gate: { flagKey: 'fs_services', permPrefix: 'fs.services', scopeKey: 'services' },
  model: () => NativeService,
  ids: { business: 'serviceId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('categoryId', 'Category', 'ref', 'list', { ...col(2), ref: { module: 'category', targetField: '_id', idFormat: 'objectId' } }),
    f('price', 'Price', 'money', 'list', { ...col(2), ...branchMoney }),
    // The unit of `duration` is not recorded anywhere (the Services screen
    // doesn't show it), so it is a plain number, never a duration.
    f('duration', 'Duration', 'number', 'detail'),
    f('description', 'Description', 'longtext', 'detail'),
    f('serviceId', 'Service ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, unit: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.service,
};

const part: ModuleCap = {
  key: 'part',
  group: 'field_service',
  labels: { singular: 'Part', plural: 'Parts', synonyms: ['part', 'parts', 'spare part', 'spare parts', 'spares'] },
  gate: { flagKey: 'fs_parts', permPrefix: 'fs.parts', scopeKey: 'parts' },
  model: () => NativePart,
  ids: { business: 'partId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('partNumber', 'Part number', 'text', 'list', col(2)),
    f('price', 'Price', 'money', 'list', { ...col(2), ...branchMoney }),
    f('quantity', 'Quantity', 'number', 'list', col(3)),
    f('description', 'Description', 'longtext', 'detail'),
    f('partId', 'Part ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, unit: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.part,
};

const product: ModuleCap = {
  key: 'product',
  group: 'field_service',
  labels: { singular: 'Product', plural: 'Products', synonyms: ['product', 'products'] },
  gate: { flagKey: 'fs_products', permPrefix: 'fs.products', scopeKey: 'products' },
  model: () => NativeProduct,
  ids: { business: 'productId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('sku', 'SKU', 'text', 'list', col(2)),
    f('sellingPrice', 'Selling price', 'money', 'list', { ...col(2), ...branchMoney }),
    f('stock', 'Stock', 'number', 'list', col(3)),
    f('category', 'Category', 'text', 'detail'),
    f('description', 'Description', 'longtext', 'detail'),
    f('productId', 'Product ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, unit: 'detail_only', costPrice: 'detail_only', barcode: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.product,
};

const asset: ModuleCap = {
  key: 'asset',
  group: 'field_service',
  labels: { singular: 'Asset', plural: 'Assets', synonyms: ['asset', 'assets', 'equipment'] },
  gate: { flagKey: 'fs_assets', permPrefix: 'fs.assets', scopeKey: 'assets' },
  model: () => NativeAsset,
  ids: { business: 'assetId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['retired'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'unsupported', reason: "An asset's assignee is free text, not linked to a staff record." },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('serialNumber', 'Serial number', 'text', 'list', col(2)),
    f('condition', 'Condition', 'enum', 'list', { ...col(3), ...fromSchema }),
    f('warrantyExpiry', 'Warranty expiry', 'date', 'list', { ...col(3), dateRule: 'date' }),
    f('purchaseDate', 'Purchase date', 'date', 'detail', { dateRule: 'date' }),
    f('assetId', 'Asset ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, category: 'detail_only', assignedTo: 'detail_only', currentSite: 'detail_only', notes: 'detail_only',
    updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.asset,
};

const vehicle: ModuleCap = {
  key: 'vehicle',
  group: 'field_service',
  labels: { singular: 'Vehicle', plural: 'Vehicles', synonyms: ['vehicle', 'vehicles', 'fleet'] },
  gate: { flagKey: 'fs_vehicles', permPrefix: 'fs.vehicles', scopeKey: 'vehicles' },
  model: () => NativeVehicle,
  ids: { business: 'vehicleId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['retired'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'unsupported', reason: "A vehicle's driver is free text, not linked to a staff record." },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('registrationNumber', 'Registration', 'text', 'list', col(2)),
    f('make', 'Make', 'text', 'list', col(3)),
    f('lastServiceDate', 'Last service', 'date', 'list', { ...col(3), dateRule: 'date' }),
    f('vehicleId', 'Vehicle ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, vehicleModel: 'detail_only', year: 'detail_only', assignedTeam: 'detail_only', assignedDriver: 'detail_only',
    fuelType: 'detail_only', notes: 'detail_only', updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.vehicle,
};

const expense: ModuleCap = {
  key: 'expense',
  group: 'field_service',
  labels: { singular: 'Expense', plural: 'Expenses', synonyms: ['expense', 'expenses', 'expense claim', 'expense claims'] },
  gate: { flagKey: 'fs_expenses', permPrefix: 'fs.expenses', scopeKey: 'expenses' },
  model: () => NativeExpense,
  ids: { business: 'expenseId', businessUnique: false, title: ['title'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['approved', 'rejected'] },
  dates: { default: 'date', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('amount', 'Amount', 'money', 'list', { ...col(2), ...branchMoney }),
    f('date', 'Date', 'date', 'list', { ...col(2), dateRule: 'date' }),
    f('category', 'Category', 'text', 'list', col(3)),
    f('expenseId', 'Expense ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, paidBy: 'detail_only', workOrderId: 'detail_only', notes: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.expense,
};

const site: ModuleCap = {
  key: 'site',
  group: 'field_service',
  labels: { singular: 'Site', plural: 'Sites', synonyms: ['site', 'sites', 'customer site', 'customer sites'] },
  gate: { flagKey: 'fs_sites', permPrefix: 'fs.sites', scopeKey: 'sites' },
  model: () => NativeSite,
  ids: { business: 'siteId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    // list() populates it; the gateway keeps only the customer's _id and name.
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ref: { module: 'customer', targetField: '_id', idFormat: 'objectId' } }),
    f('city', 'City', 'text', 'list', col(2)),
    f('address', 'Address', 'text', 'detail', { pii: { module: 'sites', encrypted: true } }),
    f('contactPerson', 'Contact person', 'text', 'detail'),
    f('siteId', 'Site ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, state: 'detail_only', postcode: 'detail_only', country: 'detail_only', phone: 'detail_only',
    notes: 'detail_only', latitude: 'internal', longitude: 'internal', updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.site,
};

const team: ModuleCap = {
  key: 'team',
  group: 'field_service',
  labels: { singular: 'Team', plural: 'Teams', synonyms: ['team', 'teams'] },
  gate: { flagKey: 'fs_teams', permPrefix: 'fs.teams', scopeKey: 'teams' },
  model: () => NativeTeam,
  ids: { business: 'teamId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'unsupported', reason: 'Teams have no owner; an admin sets who manages each team.' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('description', 'Description', 'longtext', 'list', col(2)),
    f('managerUserId', 'Supervisor', 'ref', 'detail', { ref: { module: 'supervisor', targetField: '_id', idFormat: 'objectId' } }),
    f('teamId', 'Team ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, showInWidget: 'internal', serviceIds: 'detail_only', source: 'internal', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.team,
};

const staff: ModuleCap = {
  key: 'staff',
  group: 'field_service',
  labels: {
    singular: 'Staff member', plural: 'Staff',
    synonyms: [
      'staff', 'staffs', 'staff member', 'staff members', 'field staff', 'technician', 'technicians', 'employee', 'employees',
    ],
  },
  gate: { flagKey: 'fs_staffs', permPrefix: 'fs.staffs', scopeKey: 'staffs' },
  model: () => NativeStaff,
  ids: { business: 'staffId', businessUnique: false, title: ['firstName lastName'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'unsupported', reason: 'A staff record describes a person; it has no owner.' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('firstName', 'First name', 'text', 'list', col(1)),
    f('lastName', 'Last name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('role', 'Role', 'text', 'list', col(2)),
    // list() populates it with the team's name.
    f('teamId', 'Team', 'ref', 'list', { ...col(2), ref: { module: 'team', targetField: '_id', idFormat: 'objectId' } }),
    f('email', 'Email', 'email', 'detail', { pii: { module: 'staffs', encrypted: true } }),
    f('phone', 'Phone', 'phone', 'detail', { pii: { module: 'staffs', encrypted: true } }),
    f('staffId', 'Staff ID', 'id', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, ...APP_LOGIN, userId: 'system', skills: 'detail_only', location: 'secret', source: 'internal',
    updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.staff,
};

const customer: ModuleCap = {
  key: 'customer',
  group: 'field_service',
  labels: {
    singular: 'Customer', plural: 'Customers',
    synonyms: ['customer', 'customers', 'client', 'clients', 'field service customer', 'field service customers'],
  },
  gate: { flagKey: 'fs_customers', permPrefix: 'fs.customers', scopeKey: 'customers' },
  model: () => NativeCustomer,
  ids: { business: 'customerId', businessUnique: false, title: ['name'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'owner_ids', field: 'assignedStaffId', match: ['userId', 'ownStaffId'] },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('customerId', 'Customer ID', 'id', 'list', col(2)),
    f('company', 'Company', 'text', 'list', col(2)),
    f('city', 'City', 'text', 'list', col(3)),
    f('email', 'Email', 'email', 'detail', { pii: { module: 'customers', encrypted: true, blindIndex: 'emailSearch' } }),
    f('phone', 'Phone', 'phone', 'detail', { pii: { module: 'customers', encrypted: true, blindIndex: 'phoneSearch' } }),
    f('country', 'Country', 'text', 'detail'),
    f('assignedStaffId', 'Assigned staff', 'text', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS, ...SEARCH_INDEXES, ...APP_LOGIN,
    designation: 'detail_only', mobile: 'detail_only', addEmail: 'detail_only', addPhone: 'detail_only',
    website: 'detail_only', address: 'detail_only', state: 'detail_only', postcode: 'detail_only',
    billingName: 'detail_only', billingAddress: 'detail_only', deliveryAddress: 'detail_only', notes: 'detail_only',
    tags: 'detail_only', leadId: 'detail_only', opportunityId: 'detail_only', updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.customer,
};

const deal: ModuleCap = {
  key: 'deal',
  group: 'field_service',
  labels: {
    singular: 'Deal', plural: 'Deals',
    synonyms: ['deal', 'deals', 'opportunity', 'opportunities', 'sales opportunity', 'sales opportunities'],
  },
  gate: { flagKey: 'native_deals', permPrefix: 'native_crm.deals', scopeKey: 'deals' },
  model: () => Deal,
  ids: { businessUnique: false, title: ['title'] },
  stage: { field: 'stage', pipeline: 'deal' },
  dates: { default: 'createdAt', created: 'createdAt', due: 'closeDate' },
  mine: { kind: 'owner_ids', field: 'assignedStaffId', match: ['userId', 'ownStaffId'] },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: {
    default: { by: 'createdAt', dir: 'desc' },
    listSortable: ['title', 'stage', 'amount', 'currency', 'closeDate', 'contactName', 'companyName', 'createdAt', 'updatedAt'],
  },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('stage', 'Stage', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'deal' } }),
    f('amount', 'Amount', 'money', 'list', { ...col(2), money: { currency: { field: 'currency' } } }),
    // Optional, with no default: a window on it says how many deals it leaves
    // out for having none (undatedNotice), won value's windows too.
    f('closeDate', 'Close date', 'date', 'list', { ...col(2), dateRule: 'date', undatedNotice: true }),
    f('companyName', 'Company', 'text', 'list', col(3)),
    f('contactName', 'Contact', 'text', 'list', col(3)),
    f('currency', 'Currency', 'text', 'detail'),
    created('detail'),
    updated(),
    f('assignedStaffId', 'Owner', 'text', 'hidden'),
    f('contactId', 'Contact record', 'ref', 'hidden', { ref: { module: 'contact', targetField: '_id', idFormat: 'objectId' } }),
    f('companyId', 'Company record', 'ref', 'hidden', { ref: { module: 'company', targetField: '_id', idFormat: 'objectId' } }),
  ],
  ignoredPaths: {
    _id: 'system', __v: 'system', tenantId: 'system', branchId: 'system', clientId: 'internal', createdBy: 'system',
    customFields: 'detail_only', ...LOCKS,
    notes: 'detail_only', tags: 'detail_only', leadId: 'detail_only', importBatchId: 'internal',
  },
  routes: ROUTE_TEMPLATES.deal,
};

const activity: ModuleCap = {
  key: 'activity',
  group: 'field_service',
  labels: { singular: 'Activity', plural: 'Activities', synonyms: ['activity', 'activities'] },
  gate: { flagKey: 'fs_activities', permPrefix: 'fs.activities', scopeKey: 'activities' },
  model: () => NativeActivity,
  ids: { business: 'activityId', businessUnique: false, title: ['subject'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: ['completed', 'cancelled'] },
  dates: { default: 'scheduledAt', created: 'createdAt', due: 'scheduledAt', start: 'scheduledAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('subject', 'Subject', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('type', 'Type', 'enum', 'list', { ...col(2), ...fromSchema }),
    f('scheduledAt', 'Scheduled', 'date', 'list', { ...col(2), dateRule: 'date' }),
    f('activityId', 'Activity ID', 'id', 'list', col(3)),
    f('assignedTo', 'Assigned to', 'text', 'detail'),
    f('completedAt', 'Completed', 'datetime', 'detail', { dateRule: 'instant' }),
    f('description', 'Description', 'longtext', 'detail'),
    f('relatedModule', 'Related to', 'text', 'detail'),
    f('relatedId', 'Related record', 'text', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.activity,
};

/** Supervisors have no model of their own: a supervisor is a login User with
 * role MANAGER that is not deactivated (supervisor-read.service.ts). The
 * entry describes the User model, and every read goes through the module
 * map's list(), which selects only _id, names and email and adds teamNames.
 * The engine must never query User directly for this module. */
const supervisor: ModuleCap = {
  key: 'supervisor',
  group: 'field_service',
  labels: { singular: 'Supervisor', plural: 'Supervisors', synonyms: ['supervisor', 'supervisors'] },
  gate: { flagKey: 'fs_supervisors', permPrefix: 'users', scopeKey: 'users' },
  model: () => User,
  ids: { businessUnique: false, title: ['firstName lastName'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'unsupported', reason: 'Supervisors are user accounts; they have no owner.' },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'firstName', dir: 'asc' }, listSortable: [] },
  fields: [
    f('firstName', 'First name', 'text', 'list', col(1)),
    f('lastName', 'Last name', 'text', 'list', col(1)),
    f('email', 'Email', 'email', 'list', { ...col(2), pii: { module: 'users', encrypted: false } }),
    f('teamNames', 'Teams managed', 'text', 'list', { ...col(2), virtual: true }),
    created('hidden'),
  ],
  ignoredPaths: {
    _id: 'system', __v: 'system', tenantId: 'system', branchId: 'system', clientId: 'internal', roleId: 'system',
    role: 'internal', isActive: 'internal', updatedAt: 'system',
    password: 'secret', passwordEnc: 'secret', refreshToken: 'secret', loginId: 'secret',
    emailVerificationToken: 'secret', emailVerificationExpiry: 'secret', passwordResetToken: 'secret',
    passwordResetExpiry: 'secret', mustChangePassword: 'internal', emailVerified: 'internal', lastLogin: 'internal',
    sidebarLayout: 'internal',
  },
  routes: ROUTE_TEMPLATES.supervisor,
};

/** Field Service modules (sidebar group "Field Service"). */
export const FIELD_SERVICE_CAPS: ModuleCap[] = [
  lead, deal, workorder, invoice, customer, site, staff, team, supervisor, activity,
  category, service, part, product, asset, vehicle, expense,
];
