import type { WriteManifest, WriteRefSpec } from '../registry/types';
import type { WorkflowModule, WriteRuleContext, WriteRuleResult } from './workflow-types';
import { escapeRegex } from '../../../utils/escape-regex';
import { Tenant } from '../../tenants/tenant.model';
import { NativeService } from '../../native-crm/services/service.model';
import { NativeTeam } from '../../native-crm/teams/team.model';
import { NativeWorkorder } from '../../native-crm/workorders/workorder.model';
import { NativeQuotation } from '../../native-crm/quotations/quotation.model';
import { NativeContract } from '../../native-crm/contracts/contract.model';
import {
  ALL_OPS, APP_LOGIN_FIELDS, FROM_SCHEMA, NAME_SPLIT, SEARCH_REMOVED, SEARCH_UPDATED, STAFF,
  anyLinked, changes, field, noFindings, tenantObjectId, textOf, value, will,
} from './simple.workflow';

/* The ten remaining simple modules' guided forms (Increment 7, spec B8,
 * M23): categories, services, parts, products, assets, vehicles, expenses,
 * sites, teams and staff. Each WriteCap is the screen's own fields (L26),
 * with the model's defaults and the review card's side-effect lines; every
 * cap allows create, update and delete, takes the module's custom fields
 * and is versioned by compare-and-set. The writes only ever go through
 * executeWrite and the module map's closures, which is all their screens do:
 * none of the ten has hooks, automations or a record lock, and no automation
 * rule or flow can target them, so their cards leave out the scheduled-rules
 * line (noScheduledRules).
 *
 * Never written from chat (privileged): what decides who sees what (team
 * managerUserId, staff teamId and userId, D28), the website chat's
 * departments and routing (team serviceIds and showInWidget), staff role (a
 * reserved intent key), service duration (its unit is recorded nowhere) and
 * site country, latitude and longitude (on no screen).
 *
 * The rules only read: the team name check (the service refuses a
 * duplicate), the vehicle's year against its last service date, the
 * visibility and website-chat warnings, and the delete warnings (never
 * blocks: no delete of the ten is refused by its service; generic texts,
 * never counts). */

export type ReferenceModule = 'category' | 'service' | 'part' | 'product' | 'asset' | 'vehicle' | 'expense' | 'site' | 'team' | 'staff';

/* ── Texts (spec B12: simple10.md 4.4) ── */
const ID_ASSIGNED = 'An ID is assigned when it is saved.';
const STAFF_APP_LOGIN = 'App login details are prepared for the new staff member. Nothing is sent to them.';
const STAFF_LOGIN_ENDS = 'Their staff app login stops working.';
const STAFF_ASSIGNMENTS_STAY = 'Records assigned to this staff member keep the assignment.';
const TEAM_STAFF_STAY = 'Staff in this team are not moved; they will show no team.';
const TEAM_NAME_UNIQUE = 'A team with the same name as an existing team is refused.';
const PRICE_LATER = 'Documents made after this use the new price. Existing documents keep their own.';
const CATEGORY_IN_USE = 'Services in this category are not changed and will show no category.';
const SITE_IN_USE = 'Work orders, quotations or contracts that name this site are not changed.';
const TEAM_HIDDEN_AFTER_CREATE = "You won't see this team after creating it. An administrator sets who manages each team.";
const STAFF_HIDDEN_AFTER_CREATE = "You won't see this staff member after creating it. An administrator decides which team they join.";
const TEAM_ON_WEBSITE = 'This team is a department in your website chat, so visitors see this change.';
const TEAM_HAS_MANAGER = 'This team has a manager, who will no longer see its staff or their records through it.';
const TEAM_USED_BY_WEBSITE = 'Your website chat uses this team. Check the website chat settings after deleting it.';
const STAFF_LINKED_LOGIN = 'This staff member is linked to a CRM login. After the delete, that user no longer sees records through this staff profile.';
const STAFF_NOT_ACTIVE = "A staff member who isn't active can't sign in to the staff app and isn't picked for website-chat leads or bookings.";
/** The screen schema's own message (vehicle.validation.ts), so it reads the same whichever side finds it. */
const VEHICLE_SERVICE_BEFORE_YEAR = 'Last service date cannot be earlier than manufacture year';
/** team.service.ts assertUniqueTeamName's message, plus the full stop. */
const teamExists = (name: string) => `A team named "${name}" already exists.`;

/* ── Shorthands ── */
/** As the Categories screen writes a service's category, and as the registry has it: the category's _id. */
const CATEGORY_REF: WriteRefSpec = { module: 'category', store: 'objectId', targetField: '_id' };
/** As the Sites screen stores the customer, and as the registry has it: the customer's _id. */
const CUSTOMER_OID: WriteRefSpec = { module: 'customer', store: 'objectId', targetField: '_id' };
/** The card lines most of the ten share: the ID and search, and no scheduled-rules line. */
const LISTED = (create: readonly string[] = []): WriteManifest => ({
  will: { create: [ID_ASSIGNED, SEARCH_UPDATED, ...create], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED] },
  noScheduledRules: true,
});

/* ── Rules (read-only) ── */
async function checkCategory(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  // deleteCategory has no check: a warning, not a block.
  if (input.op === 'delete' && input.record
    && await anyLinked([NativeService], { tenantId: tenantObjectId(input.identity.tenantId), categoryId: input.record._id })) {
    out.warnings.push(CATEGORY_IN_USE);
  }
  return out;
}

/** Service and part: catalog prices feed new document lines only (a line stores its own amount). */
async function checkPriced(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  if (input.op === 'update' && changes(input, 'price')) out.sideEffects.push(will(PRICE_LATER));
  return out;
}

/** The screen sends year and lastServiceDate on every save, so its schema always compares them; a chat
 * update sends only what changed, so the other one is the record's. Same comparison (server-local year). */
async function checkVehicle(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  if (input.op !== 'update' || !input.record) return out;
  const own = (k: string) => Object.prototype.hasOwnProperty.call(input.values, k);
  // Both or neither: the schema itself compares them.
  if (own('year') === own('lastServiceDate')) return out;
  const year = Number(own('year') ? input.values.year : input.record.year);
  const raw = own('lastServiceDate') ? input.values.lastServiceDate : input.record.lastServiceDate;
  const day = raw ? new Date(raw as string) : null;
  if (year && day && !Number.isNaN(day.getTime()) && day.getFullYear() < year) out.fieldErrors.lastServiceDate = VEHICLE_SERVICE_BEFORE_YEAR;
  return out;
}

/** A "Paid by me" pick (the field's label makes "Assign to me" read wrong). */
async function checkExpense(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  const me = input.ctx.ownStaff;
  if (input.op !== 'delete' && me) out.quickPicks = { paidBy: [{ label: 'Paid by me', value: { ref: me.id, label: me.label } }] };
  return out;
}

async function checkSite(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  // deleteSite has no check; work orders, quotations and contracts keep the siteId text.
  if (input.op === 'delete' && input.record?.siteId && await anyLinked([NativeWorkorder, NativeQuotation, NativeContract],
    { tenantId: tenantObjectId(input.identity.tenantId), siteId: input.record.siteId })) {
    out.warnings.push(SITE_IN_USE);
  }
  return out;
}

async function checkTeam(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  const { op, mode, values, record, ctx } = input;
  const tid = tenantObjectId(input.identity.tenantId);
  if (op === 'delete') {
    if (!record) return out;
    if (record.managerUserId) out.warnings.push(TEAM_HAS_MANAGER);
    const tenant = await Tenant.findById(tid).select('widget.defaultTeamId').lean();
    if (record.showInWidget === true || String((tenant as any)?.widget?.defaultTeamId ?? '') === String(record._id)) out.warnings.push(TEAM_USED_BY_WEBSITE);
    return out;
  }
  // The service refuses a case-insensitive duplicate name, tenant-wide: said before Confirm.
  const name = textOf(values.name).trim();
  if (mode !== 'draft' && name && (op === 'create' || changes(input, 'name'))) {
    const filter: Record<string, unknown> = { tenantId: tid, name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
    if (record) filter._id = { $ne: record._id };
    if (await NativeTeam.exists(filter)) out.formErrors.push(teamExists(name));
  }
  // A scoped caller sees teams by _id in scope.teamIds, and chat can't set the manager (D28).
  if (op === 'create' && ctx.scope.kind !== 'all') out.warnings.push(TEAM_HIDDEN_AFTER_CREATE);
  if (op === 'update' && record?.showInWidget === true && (changes(input, 'name') || changes(input, 'status'))) out.warnings.push(TEAM_ON_WEBSITE);
  return out;
}

async function checkStaff(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  const { op, values, record, ctx } = input;
  if (op === 'delete') {
    if (record?.userId) out.warnings.push(STAFF_LINKED_LOGIN);
    return out;
  }
  // A scoped caller sees staff by staffId in scope, and a chat-made staff member has no team (D28).
  if (op === 'create' && ctx.scope.kind !== 'all') out.warnings.push(STAFF_HIDDEN_AFTER_CREATE);
  const status = textOf(values.status);
  if (status && status !== 'active' && (op === 'create' || changes(input, 'status'))) out.sideEffects.push(will(STAFF_NOT_ACTIVE));
  return out;
}

/* ── The ten WriteCaps ── */
const category: WorkflowModule = {
  cap: {
    module: 'category', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('description', 'Description', 'longtext'),
      field('color', 'Color', 'text', { help: 'A hex colour, like #6366f1.' }),
      field('icon', 'Icon', 'text'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    // categoryId is the category's own number. The screen's Services picker writes other records (each
    // service's categoryId): the service form sets it.
    privilegedFields: ['categoryId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
  rules: { check: checkCategory },
};

const service: WorkflowModule = {
  cap: {
    module: 'service', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('description', 'Description', 'longtext'),
      // What the Categories screen writes for this service: the category's _id.
      field('categoryId', 'Category', 'ref', { ref: CATEGORY_REF }),
      field('price', 'Price', 'money', { min: 0 }),
      field('unit', 'Unit', 'text', { help: 'For example hour, sq.ft or visit.' }),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    // duration: no screen shows it and its unit is recorded nowhere (as a call's duration, L19).
    privilegedFields: ['serviceId', 'numId', 'clientId', 'duration'],
    manifest: LISTED(),
  },
  rules: { check: checkPriced },
};

const part: WorkflowModule = {
  cap: {
    module: 'part', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('partNumber', 'Part number', 'text', { help: 'Your SKU or code.' }),
      field('description', 'Description', 'longtext'),
      field('price', 'Price', 'money', { min: 0 }),
      field('unit', 'Unit', 'text'),
      field('quantity', 'Quantity', 'number', { min: 0 }),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    privilegedFields: ['partId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
  rules: { check: checkPriced },
};

const product: WorkflowModule = {
  cap: {
    module: 'product', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('sku', 'SKU', 'text'),
      // Plain text on the Products screen, not one of the service categories.
      field('category', 'Category', 'text'),
      field('unit', 'Unit', 'text'),
      field('costPrice', 'Cost price', 'money', { min: 0 }),
      field('sellingPrice', 'Selling price', 'money', { min: 0 }),
      field('stock', 'Stock', 'number', { min: 0 }),
      field('barcode', 'Barcode', 'text'),
      field('description', 'Description', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    privilegedFields: ['productId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
};

const asset: WorkflowModule = {
  cap: {
    module: 'asset', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('category', 'Category', 'text'),
      field('serialNumber', 'Serial number', 'text'),
      field('purchaseDate', 'Purchase date', 'date', { quickPicks: ['today'] }),
      field('warrantyExpiry', 'Warranty expiry', 'date', { future: true }),
      // The screen's staff picker stores the staffId.
      field('assignedTo', 'Assigned to', 'ref', { ref: STAFF, quickPicks: ['assign_to_me'] }),
      // Free text on the screen (placeholder "Site ID"), which nothing reads as a site.
      field('currentSite', 'Current site', 'text', { help: "The site's ID, as on the Assets screen." }),
      field('condition', 'Condition', 'enum', { options: FROM_SCHEMA }),
      field('notes', 'Notes', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    privilegedFields: ['assetId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
};

const vehicle: WorkflowModule = {
  cap: {
    module: 'vehicle', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('registrationNumber', 'Registration number', 'text'),
      field('make', 'Make', 'text'),
      field('vehicleModel', 'Model', 'text'),
      // 1900 to next year; the upper bound is the screen schema's own.
      field('year', 'Year', 'number', { integer: true, min: 1900 }),
      field('assignedTeam', 'Assigned team', 'text'),
      field('assignedDriver', 'Assigned driver', 'text'),
      field('fuelType', 'Fuel type', 'enum', { options: FROM_SCHEMA }),
      // Not in the future (server clock, as on the screen): no "today" pick, which can be tomorrow on the server's clock.
      field('lastServiceDate', 'Last service date', 'date'),
      field('notes', 'Notes', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    privilegedFields: ['vehicleId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
  rules: { check: checkVehicle },
};

const expense: WorkflowModule = {
  cap: {
    module: 'expense', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'title',
    fields: [
      field('title', 'Title', 'text', { maxLength: 300, required: true }),
      field('category', 'Category', 'text', { help: 'For example Fuel, Materials or Labour.' }),
      field('amount', 'Amount', 'money', { min: 0, required: true }),
      field('date', 'Date', 'date', { quickPicks: ['today'] }),
      // The screen's staff picker stores the staffId.
      field('paidBy', 'Paid by', 'ref', { ref: STAFF }),
      // Free text on the screen (placeholder "Link to work order"), which nothing reads as a work order.
      field('workOrderId', 'Work order ID', 'text'),
      field('notes', 'Notes', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('pending') }),
    ],
    privilegedFields: ['expenseId', 'numId', 'clientId'],
    manifest: LISTED(),
  },
  rules: { check: checkExpense },
};

const site: WorkflowModule = {
  cap: {
    module: 'site', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name', forRef: 'customerId',
    fields: [
      // As the Sites screen stores it: the customer's _id (a work order stores the customer's number instead).
      field('customerId', 'Customer', 'ref', { ref: CUSTOMER_OID }),
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('address', 'Address', 'longtext', { required: true, pii: true }),
      field('city', 'City', 'text'),
      field('state', 'State', 'text'),
      field('postcode', 'Postcode', 'text'),
      field('contactPerson', 'Contact person', 'text'),
      field('phone', 'Phone', 'phone', { pii: true }),
      field('notes', 'Notes', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    // country: in the schema, not on the Sites screen. latitude and longitude: never set by a screen.
    privilegedFields: ['siteId', 'numId', 'clientId', 'country', 'latitude', 'longitude'],
    manifest: LISTED(),
  },
  rules: { check: checkSite },
};

const team: WorkflowModule = {
  cap: {
    module: 'team', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('description', 'Description', 'longtext'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    // D28: managerUserId, and membership (Staff.teamId, the screen's Staff Members picker). serviceIds and
    // showInWidget: the website chat's departments and routing. source: provenance only.
    privilegedFields: ['teamId', 'numId', 'clientId', 'managerUserId', 'serviceIds', 'showInWidget', 'source'],
    manifest: {
      will: { create: [ID_ASSIGNED, SEARCH_UPDATED], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED, TEAM_STAFF_STAY] },
      blocked: { create: [TEAM_NAME_UNIQUE], update: [TEAM_NAME_UNIQUE] },
      noScheduledRules: true,
    },
  },
  rules: { check: checkTeam },
};

const staff: WorkflowModule = {
  cap: {
    module: 'staff', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'firstName', nameSplit: NAME_SPLIT,
    fields: [
      field('firstName', 'First name', 'text', { maxLength: 100, required: true }),
      field('lastName', 'Last name', 'text', { maxLength: 100, required: true }),
      field('email', 'Email', 'email', { pii: true }),
      field('phone', 'Phone', 'phone', { pii: true }),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
    ],
    // D28: teamId; userId (the screen's Linked Login) defines the same visibility. role is a reserved intent
    // key (contracts/plan.ts) and stays on the Staff page.
    privilegedFields: ['staffId', 'numId', 'clientId', 'teamId', 'userId', 'role', 'source', 'skills', 'location', ...APP_LOGIN_FIELDS],
    manifest: {
      will: {
        create: [ID_ASSIGNED, STAFF_APP_LOGIN, SEARCH_UPDATED],
        update: [SEARCH_UPDATED],
        delete: [SEARCH_REMOVED, STAFF_LOGIN_ENDS, STAFF_ASSIGNMENTS_STAY],
      },
      noScheduledRules: true,
    },
  },
  rules: { check: checkStaff },
};

export const REFERENCE_WORKFLOWS: Readonly<Record<ReferenceModule, WorkflowModule>> = {
  category, service, part, product, asset, vehicle, expense, site, team, staff,
};
