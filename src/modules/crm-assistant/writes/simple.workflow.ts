import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import type { DataScope } from '../../../types';
import type { SideEffect } from '../contracts/views';
import type { BuiltInPipelineModule } from '../../native-crm/pipeline-config/pipeline-config.model';
import type {
  WriteDefault, WriteFieldKind, WriteFormField, WriteOptionsSource, WriteRefSpec, WriteRelatedSpec,
} from '../registry/types';
import type { WorkflowModule, WriteRuleContext, WriteRuleResult } from './workflow-types';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { findCustomerDuplicate } from '../../native-crm/shared/record-write-hooks/customer.hooks';
import { findLeadDuplicate } from '../../native-crm/shared/record-write-hooks/lead.hooks';
import { findContactDuplicate } from '../../native-crm/shared/record-write-hooks/contact.hooks';
import {
  CONTACT_DUPLICATE_WARNING, CUSTOMER_DUPLICATE_MESSAGE, LEAD_DUPLICATE_MESSAGE,
} from '../../native-crm/shared/record-write-hooks/types';
import { NativeQuotation } from '../../native-crm/quotations/quotation.model';
import { NativeWorkorder } from '../../native-crm/workorders/workorder.model';
import { NativeInvoice } from '../../native-crm/invoices/invoice.model';
import { NativeReceipt } from '../../native-crm/receipts/receipt.model';
import { NativeContract } from '../../native-crm/contracts/contract.model';
import { Deal } from '../../native-crm/deals/deal.model';
import { Lead } from '../../native-crm/leads/lead.model';
import { Contact } from '../../native-crm/contacts/contact.model';

/* The nine simple modules' guided forms (Increment 6, spec B14): task,
 * ticket, call, company, contact, lead, deal, customer and activity. Each
 * WriteCap is the set of fields a chat form may write (the screen's own
 * fields, L26), with their defaults and the review card's side-effect
 * lines. Every cap allows create, update and delete and takes the module's
 * custom fields; lead, deal, contact and company are versioned by their own
 * services' token, the rest by compare-and-set. The writes themselves only
 * ever go through executeWrite and the module map's closures.
 *
 * The rules only read: the duplicate checks (lead and customer refuse,
 * contact warns), the delete pre-checks (generic texts, never counts), the
 * owner and visibility warnings, the won-lock line (peekStages, never the
 * stage functions that can write) and the ticket's SLA line. */

type SimpleModule = 'task' | 'ticket' | 'call' | 'company' | 'contact' | 'lead' | 'deal' | 'customer' | 'activity';

/* ── Texts (spec B14, B20) ── */
const TIMELINE_LINE = 'The record timeline and search are updated, as when you save on the screen.';
const TASK_TIMELINE_LINE = "The task's timeline and search are updated.";
export const SEARCH_UPDATED = 'Search is updated.';
export const SEARCH_REMOVED = 'It is removed from search.';
const DELETE_TIMELINE_AND_AUDIT = 'The timeline records the delete and an audit entry is written.';
const TICKET_SLA_LATER = 'SLA warning and breach rules may act on this ticket later.';
const TICKET_SLA_RECALCULATED = 'Changing the priority recalculates the SLA due dates from now.';
const TASK_TIME_NOT_SAVED = "Tasks keep a due date; the time isn't saved.";
const LEAD_TEAM_CLEARED = "The lead's team is cleared when the owner changes, as on the screen.";
const CUSTOMER_HIDDEN_AFTER_CREATE = "You won't see this customer after creating it unless it's assigned to you.";
const CUSTOMER_LINKED = "This customer has linked work orders, quotations, invoices, receipts or contracts, so it can't be deleted. Open it on its page to see them.";
const CONTACT_LINKED = "This contact has deals or leads linked to it, so it can't be deleted. Open it on its page to see them.";
const COMPANY_LINKED = "This company has contacts or deals linked to it, so it can't be deleted. Open it on its page to see them.";
const reassignMayHide = (singular: string) => `You may not see this ${singular} after this change.`;
const wonLockLine = (singular: string) =>
  `If auto-lock is set up, a ${singular} moved to its won stage is locked. After that, only an administrator can change it.`;

/* ── Field shorthands ── */
export const ALL_OPS = ['create', 'update', 'delete'] as const;
export const FORM_OPS = ['create', 'update'] as const;
/** Kinds that name a record or an owner: picked or resolved, never filled from words as a value (a planner value could carry any id). */
const PICKED_KINDS: ReadonlySet<WriteFieldKind> = new Set<WriteFieldKind>(['ref', 'ref_many', 'owner_user', 'related']);

/** A field on the create and update forms: optional, and planner-fillable unless it names a record or an owner. */
export function field(key: string, label: string, kind: WriteFieldKind, extra: Partial<WriteFormField> = {}): WriteFormField {
  return { key, label, kind, ops: FORM_OPS, required: false, plannerFillable: !PICKED_KINDS.has(kind), ...extra };
}
export const FROM_SCHEMA: WriteOptionsSource = { from: 'schema' };
const pipeline = (module: BuiltInPipelineModule): WriteOptionsSource => ({ from: 'pipeline', pipeline: module });
export const value = (v: string): WriteDefault => ({ kind: 'value', value: v });
const stage = (preferred: string): WriteDefault => ({ kind: 'stage', preferred });
/** A Field Service staff member, stored by the staffId the screens' staff selects store. */
export const STAFF: WriteRefSpec = { module: 'staff', store: 'business', targetField: 'staffId' };
/** Task, ticket and call: the modules their Zod schemas accept (FsRelationPicker also offers product and
 * asset, which the schemas refuse), stored by _id with the label the screen writes (number and name). */
const RELATED: WriteRelatedSpec = {
  modules: ['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract', 'lead'], store: 'objectId', writesLabel: true,
};
export const NAME_SPLIT = { first: 'firstName', last: 'lastName' };
/** The Deals screen's currency list. */
const DEAL_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'AED', 'SGD'];
const ASSISTANT_MARKERS = ['assistantChangedAt', 'assistantFingerprint', 'reminderSuppressedAt'];
const LOCK_FIELDS = ['isLocked', 'lockedAt', 'lockedBy', 'lockReason'];
export const APP_LOGIN_FIELDS = ['appUsername', 'appPasswordHash', 'appPasswordEnc', 'appCredentialsGeneratedAt', 'appLastLoginAt'];
const BLIND_INDEXES = ['phoneSearch', 'emailDomain', 'emailSearch'];

/* ── Rules (read-only) ── */
export function noFindings(): WriteRuleResult {
  return { fieldErrors: {}, formErrors: [], warnings: [], sideEffects: [] };
}
export const will = (text: string): SideEffect => ({ kind: 'will', text });
export const textOf = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Whether this write sets `key` to something other than the record's value. */
export function changes(input: WriteRuleContext, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input.values, key) && textOf(input.values[key]) !== textOf(input.record?.[key]);
}

/** A scoped caller sees a record through its owner when the owner is one of the scope's staff or users. */
function ownerInScope(owner: unknown, scope: DataScope): boolean {
  const key = textOf(owner);
  return !!key && (scope.staffIds.includes(key) || scope.createdByUserIds.includes(key));
}

/** Lead, deal and contact (their services' scope): after an owner change a scoped caller still sees the
 * record they created, or one whose new owner is in their scope. A lead's team goes with the change. */
function reassignHides(input: WriteRuleContext, ownerKey: string): boolean {
  const { scope } = input.ctx;
  return scope.kind !== 'all'
    && !scope.createdByUserIds.includes(textOf(input.record?.createdBy))
    && !ownerInScope(input.values[ownerKey], scope);
}

/** An update that moves the record into the tenant's won stage, from a different stage, as lockLeadIfWon and
 * lockDealIfWon lock it. The key is read with peekStages (getOutcomeStageKey can create the pipeline before
 * Confirm): the active stage tagged won, else the hooks' own fallback. */
async function movesToWon(input: WriteRuleContext, key: string, module: 'lead' | 'deal', fallback: string): Promise<boolean> {
  const next = textOf(input.values[key]);
  if (!next || !changes(input, key)) return false;
  const stages = await peekStages(input.identity.tenantId, module);
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  return next === (stages.find((s) => s.outcome === 'won' && s.isActive !== false)?.key ?? fallback);
}

/** The services' own pre-delete counts, tenant-wide as there: whether anything is linked. The card never
 * says how many (the counts cross the caller's scope). */
export async function anyLinked(models: ReadonlyArray<Model<any>>, filter: Record<string, unknown>): Promise<boolean> {
  const counts = await Promise.all(models.map((model) => model.countDocuments(filter)));
  return counts.some((n) => n > 0);
}
/** contact.service.ts and company.service.ts: a link holds the record's _id or its clientId. */
function linkIdsOf(record: Readonly<Record<string, unknown>>): string[] {
  const clientId = record.clientId ? String(record.clientId) : null;
  return clientId ? [String(record._id), clientId] : [String(record._id)];
}
export const tenantObjectId = (tenantId: string) => new mongoose.Types.ObjectId(tenantId);
/** customer.service.ts deleteCustomer: these point at a customer by its number. */
const CUSTOMER_LINKS: ReadonlyArray<Model<any>> = [NativeQuotation, NativeWorkorder, NativeInvoice, NativeReceipt, NativeContract];

async function checkTicket(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  // updateTicket recomputes the SLA dates when the priority really changes.
  if (input.op === 'update' && textOf(input.values.priority) && changes(input, 'priority')) {
    out.sideEffects.push(will(TICKET_SLA_RECALCULATED));
  }
  return out;
}

async function checkCustomer(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  const { op, mode, values, record, ctx } = input;
  const tenantId = input.identity.tenantId;
  if (op === 'delete') {
    if (record && await anyLinked(CUSTOMER_LINKS, { tenantId: tenantObjectId(tenantId), customerId: record.customerId })) {
      out.blocked = CUSTOMER_LINKED;
    }
    return out;
  }
  // A scoped caller sees a customer only through its assigned staff (no createdBy fallback).
  const scoped = ctx.scope.kind !== 'all';
  if (op === 'create') {
    if (mode !== 'draft' && await findCustomerDuplicate(tenantId, { ...values })) out.formErrors.push(CUSTOMER_DUPLICATE_MESSAGE);
    if (scoped && !ownerInScope(values.assignedStaffId, ctx.scope)) out.warnings.push(CUSTOMER_HIDDEN_AFTER_CREATE);
    return out;
  }
  if (scoped && changes(input, 'assignedStaffId') && !ownerInScope(values.assignedStaffId, ctx.scope)) {
    out.warnings.push(reassignMayHide('customer'));
  }
  return out;
}

async function checkLead(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  if (input.op === 'create') {
    if (input.mode !== 'draft' && await findLeadDuplicate(input.identity.tenantId, { ...input.values })) {
      out.formErrors.push(LEAD_DUPLICATE_MESSAGE);
    }
    return out;
  }
  if (input.op !== 'update') return out;
  if (await movesToWon(input, 'status', 'lead', 'won')) out.sideEffects.push(will(wonLockLine('lead')));
  if (changes(input, 'leadOwnerStaffId')) {
    // resolveLeadReassignment: an owner who is a CRM user has no staff team.
    out.sideEffects.push(will(LEAD_TEAM_CLEARED));
    if (reassignHides(input, 'leadOwnerStaffId')) out.warnings.push(reassignMayHide('lead'));
  }
  return out;
}

async function checkDeal(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  if (input.op !== 'update') return out;
  if (await movesToWon(input, 'stage', 'deal', 'closed_won')) out.sideEffects.push(will(wonLockLine('deal')));
  if (changes(input, 'assignedStaffId') && reassignHides(input, 'assignedStaffId')) out.warnings.push(reassignMayHide('deal'));
  return out;
}

async function checkContact(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  const tenantId = input.identity.tenantId;
  if (input.op === 'delete') {
    if (input.record && await anyLinked([Deal, Lead], { tenantId: tenantObjectId(tenantId), contactId: { $in: linkIdsOf(input.record) } })) {
      out.blocked = CONTACT_LINKED;
    }
    return out;
  }
  if (input.op === 'create') {
    // The screen saves a duplicate contact and only flags it; the review is where chat can say so.
    if (input.mode === 'review' && await findContactDuplicate(tenantId, { ...input.values })) out.warnings.push(CONTACT_DUPLICATE_WARNING);
    return out;
  }
  if (changes(input, 'contactOwner') && reassignHides(input, 'contactOwner')) out.warnings.push(reassignMayHide('contact'));
  return out;
}

async function checkCompany(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out = noFindings();
  if (input.op === 'delete' && input.record
    && await anyLinked([Contact, Deal], { tenantId: tenantObjectId(input.identity.tenantId), companyId: { $in: linkIdsOf(input.record) } })) {
    out.blocked = COMPANY_LINKED;
  }
  return out;
}

/* ── The nine WriteCaps ── */
const task: WorkflowModule = {
  cap: {
    module: 'task', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'title', forRef: 'related',
    fields: [
      field('title', 'Title', 'text', { maxLength: 300, required: true }),
      // Required as on the screen; a day only, as the screen and Daily Events keep it (L21).
      field('dueDate', 'Due date', 'date', { required: true, future: true, quickPicks: ['today', 'tomorrow'], help: TASK_TIME_NOT_SAVED }),
      field('priority', 'Priority', 'enum', { options: FROM_SCHEMA, default: value('medium') }),
      field('taskStatus', 'Status', 'stage', { options: pipeline('task'), default: stage('todo') }),
      field('assignedTo', 'Assigned to', 'ref', { ref: STAFF, quickPicks: ['assign_to_me'] }),
      field('related', 'Related to', 'related', { related: RELATED }),
      field('notes', 'Notes', 'longtext'),
    ],
    // The related keys are written only through the Related field.
    privilegedFields: ['tags', 'reminderSentAt', 'clientId', 'relatedModule', 'relatedId', 'relatedLabel', 'branchId', ...ASSISTANT_MARKERS],
    manifest: {
      will: {
        create: [TASK_TIMELINE_LINE], update: [TASK_TIMELINE_LINE],
        delete: ['The timeline records the delete.', SEARCH_REMOVED],
      },
      stampedPause: true,
    },
  },
};

const ticket: WorkflowModule = {
  cap: {
    module: 'ticket', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'subject', forRef: 'related',
    fields: [
      field('subject', 'Subject', 'text', { maxLength: 300, required: true }),
      field('priority', 'Priority', 'enum', { options: FROM_SCHEMA, default: value('medium') }),
      field('ticketStatus', 'Status', 'stage', { options: pipeline('ticket'), default: stage('open') }),
      // L22: a create's "for <name>" lands here as typed, matched or not.
      field('contactName', 'Contact name', 'text', { maxLength: 200 }),
      field('related', 'Related to', 'related', { related: RELATED }),
      field('description', 'Description', 'longtext'),
    ],
    // staffId, teamId and categoryId are on the screen, but its Zod schema drops them. The SLA dates are the server's.
    privilegedFields: [
      'staffId', 'teamId', 'categoryId', 'ticketId', 'ticketNumber', 'numId', 'tags',
      'resolutionDueAt', 'firstResponseDueAt', 'resolutionWarningAt', 'firstResponseWarningAt', 'resolvedAt', 'closedAt', 'firstRespondedAt',
    ],
    manifest: {
      will: {
        create: ['A ticket number is assigned when it is saved.', 'SLA due dates are set from the priority, if SLA is on for your account.', SEARCH_UPDATED],
        update: [SEARCH_UPDATED],
        delete: ['A deletion entry is written to the audit log.', SEARCH_REMOVED],
      },
      later: { create: [TICKET_SLA_LATER], update: [TICKET_SLA_LATER] },
      stampedPause: true,
    },
  },
  rules: { check: checkTicket },
};

const call: WorkflowModule = {
  cap: {
    module: 'call', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'contactName', forRef: 'related',
    fields: [
      field('contactName', 'Contact name', 'text', { maxLength: 200, required: true }),
      field('direction', 'Direction', 'enum', { options: FROM_SCHEMA }),
      field('callStatus', 'Status', 'enum', { options: FROM_SCHEMA, default: value('planned') }),
      field('date', 'Date and time', 'datetime'),
      field('related', 'Related to', 'related', { related: RELATED }),
      field('notes', 'Notes', 'longtext'),
    ],
    // duration waits for its unit to be decided (L19); timezone is not in the screen's Zod schema.
    privilegedFields: ['duration', 'timezone', 'tags', 'reminderSentAt', ...ASSISTANT_MARKERS],
    manifest: { will: { create: [SEARCH_UPDATED], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED] }, stampedPause: true },
  },
};

const activity: WorkflowModule = {
  cap: {
    module: 'activity', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'subject', forRef: 'related',
    fields: [
      field('subject', 'Subject', 'text', { maxLength: 300, required: true }),
      field('type', 'Type', 'enum', { options: FROM_SCHEMA, default: value('note') }),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('pending') }),
      field('scheduledAt', 'Scheduled date', 'date', { future: true }),
      field('assignedTo', 'Assigned to', 'ref', { ref: STAFF, quickPicks: ['assign_to_me'] }),
      // The Activities screen's list, stored by the record's number as typed there; no label.
      field('related', 'Related to', 'related', {
        related: { modules: ['customer', 'workorder', 'quotation', 'contract', 'invoice'], store: 'business', writesLabel: false },
      }),
      field('description', 'Description', 'longtext'),
    ],
    privilegedFields: ['activityId', 'numId', 'completedAt'],
    manifest: {
      will: { create: ['An activity number is assigned when it is saved.', SEARCH_UPDATED], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED] },
    },
  },
};

const customer: WorkflowModule = {
  cap: {
    module: 'customer', ops: ALL_OPS, versionToken: 'compare_and_set', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('email', 'Email', 'email', { pii: true }),
      field('phone', 'Phone', 'phone', { pii: true }),
      field('company', 'Company', 'text'),
      field('address', 'Address', 'longtext', { pii: true }),
      field('city', 'City', 'text'),
      field('state', 'State', 'text'),
      field('postcode', 'Postcode', 'text'),
      field('country', 'Country', 'text'),
      field('billingName', 'Billing name', 'text'),
      field('billingAddress', 'Billing address', 'longtext', { pii: true }),
      field('deliveryAddress', 'Delivery address', 'longtext', { pii: true }),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
      // L20: a scoped caller's own staff profile, so the new customer stays theirs to see.
      field('assignedStaffId', 'Assigned staff', 'ref', { ref: STAFF, default: { kind: 'own_staff_if_scoped' } }),
      field('notes', 'Notes', 'longtext'),
    ],
    // The additional emails and phones are lists, kept to the customer page (L23).
    privilegedFields: [
      'customerId', 'numId', 'addEmail', 'addPhone', 'mobile', 'website', 'designation', 'tags', 'gstin', 'pan', 'leadId', 'opportunityId',
      ...LOCK_FIELDS, ...APP_LOGIN_FIELDS, ...BLIND_INDEXES,
    ],
    manifest: {
      will: {
        create: [
          'A customer number is assigned when it is saved.', 'App login details are prepared for the new customer. Nothing is sent to them.', TIMELINE_LINE,
        ],
        update: [TIMELINE_LINE],
        delete: [DELETE_TIMELINE_AND_AUDIT],
      },
      blocked: { delete: ['The delete is refused while work orders, quotations, invoices, receipts or contracts are linked to the customer.'] },
    },
  },
  rules: { check: checkCustomer },
};

const lead: WorkflowModule = {
  cap: {
    module: 'lead', ops: ALL_OPS, versionToken: 'service', customFields: true, primaryText: 'firstName', nameSplit: NAME_SPLIT,
    fields: [
      field('firstName', 'First name', 'text', { maxLength: 200, required: true }),
      field('lastName', 'Last name', 'text'),
      field('company', 'Company', 'text'),
      field('designation', 'Designation', 'text'),
      field('email', 'Email', 'email', { pii: true }),
      field('phone', 'Phone', 'phone', { pii: true }),
      field('mobile', 'Mobile', 'phone', { pii: true }),
      field('status', 'Status', 'stage', { options: pipeline('lead'), default: stage('new') }),
      field('source', 'Source', 'enum', { options: FROM_SCHEMA, default: value('manual') }),
      field('rating', 'Rating', 'enum', { options: FROM_SCHEMA, default: value('warm') }),
      // As the screen stores it: the user's id, and their "First Last" in leadOwner, which is never typed.
      field('leadOwnerStaffId', 'Owner', 'owner_user', { sets: [{ key: 'leadOwner', from: 'user_display_name' }] }),
      field('expectedRevenue', 'Expected revenue', 'money'),
      field('city', 'City', 'text'),
      field('state', 'State', 'text'),
      field('country', 'Country', 'text'),
      field('notes', 'Notes', 'longtext'),
    ],
    privilegedFields: [
      'allowDuplicate', 'skipDuplicates', 'teamId', 'teamName', 'leadOwner', 'isConverted', 'convertedCustomerId', 'convertedAt',
      'contactId', 'opportunityId', 'conversionHistory', 'leadId', 'numId', 'address', 'priority', 'score',
    ],
    manifest: {
      will: { create: ['A lead number is assigned when it is saved.', TIMELINE_LINE], update: [TIMELINE_LINE], delete: ['An audit entry is written.'] },
      blocked: { create: ['A lead with the same email or phone as an existing lead is refused.'] },
    },
  },
  rules: { check: checkLead },
};

const deal: WorkflowModule = {
  cap: {
    module: 'deal', ops: ALL_OPS, versionToken: 'service', customFields: true, primaryText: 'title', forRef: 'companyId',
    fields: [
      field('title', 'Title', 'text', { maxLength: 200, required: true }),
      field('stage', 'Stage', 'stage', { options: pipeline('deal'), default: stage('prospect') }),
      field('amount', 'Amount', 'money', { min: 0 }),
      field('currency', 'Currency', 'enum', { options: { from: 'static', values: DEAL_CURRENCIES }, default: { kind: 'branch_currency' } }),
      field('closeDate', 'Close date', 'date', { future: true }),
      field('assignedStaffId', 'Owner', 'owner_user'),
      field('contactId', 'Contact', 'ref', { ref: { module: 'contact', store: 'objectId', targetField: '_id' } }),
      field('companyId', 'Company', 'ref', { ref: { module: 'company', store: 'objectId', targetField: '_id' } }),
      field('contactName', 'Contact name', 'text', { help: 'Filled from the contact when left empty.' }),
      field('companyName', 'Company name', 'text'),
      field('notes', 'Notes', 'longtext'),
    ],
    privilegedFields: ['clientId', 'leadId', 'importBatchId', 'branchId', 'tags'],
    manifest: { will: { create: [TIMELINE_LINE], update: [TIMELINE_LINE], delete: [DELETE_TIMELINE_AND_AUDIT] } },
  },
  rules: { check: checkDeal },
};

const contact: WorkflowModule = {
  cap: {
    module: 'contact', ops: ALL_OPS, versionToken: 'service', customFields: true, primaryText: 'firstName', nameSplit: NAME_SPLIT,
    fields: [
      field('firstName', 'First name', 'text', { maxLength: 100, required: true }),
      field('lastName', 'Last name', 'text', { maxLength: 100, required: true }),
      field('email', 'Email', 'email', { required: true, pii: true }),
      field('phone', 'Phone', 'phone', { pii: true }),
      field('jobTitle', 'Job title', 'text'),
      field('company', 'Company', 'text'),
      field('status', 'Status', 'enum', { options: FROM_SCHEMA, default: value('lead') }),
      field('source', 'Source', 'enum', { options: FROM_SCHEMA }),
      field('contactOwner', 'Owner', 'owner_user'),
    ],
    privilegedFields: ['clientId', 'leadId', 'branchId', 'companyId', 'lifecycleStage', 'leadStatus', 'notes', 'tags'],
    manifest: {
      will: { create: [SEARCH_UPDATED], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED] },
      blocked: { delete: ['The delete is refused while deals or leads are linked to the contact.'] },
    },
  },
  rules: { check: checkContact },
};

const company: WorkflowModule = {
  cap: {
    module: 'company', ops: ALL_OPS, versionToken: 'service', customFields: true, primaryText: 'name',
    fields: [
      field('name', 'Name', 'text', { maxLength: 200, required: true }),
      field('companyStatus', 'Status', 'enum', { options: FROM_SCHEMA, default: value('active') }),
      field('industry', 'Industry', 'text'),
      field('domain', 'Domain', 'text'),
      field('employeeCount', 'Employees', 'number', { integer: true, min: 0 }),
      // Not PII: companies are not a PII module.
      field('phone', 'Phone', 'phone'),
      field('city', 'City', 'text'),
      field('country', 'Country', 'text'),
      field('notes', 'Notes', 'longtext'),
    ],
    privilegedFields: ['clientId', 'website', 'tags'],
    manifest: {
      will: { create: [SEARCH_UPDATED], update: [SEARCH_UPDATED], delete: [SEARCH_REMOVED] },
      blocked: { delete: ['The delete is refused while contacts or deals are linked to the company.'] },
    },
  },
  rules: { check: checkCompany },
};

export const SIMPLE_WORKFLOWS: Readonly<Record<SimpleModule, WorkflowModule>> = {
  task, ticket, call, company, contact, lead, deal, customer, activity,
};

/** L22: a ticket's Related field named in words ("a ticket for Kumar Traders") is matched against customers
 * and contacts only, and set only when exactly one of them has that whole name; contactName keeps the words
 * either way. Picking a record keeps every related module. */
const WORDS_RELATED_MODULES: Readonly<Partial<Record<SimpleModule, readonly string[]>>> = { ticket: ['customer', 'contact'] };

/** The field a reference typed as words ({ text }) is resolved with: a ticket's Related field narrowed to
 * customers and contacts (L22); any other field, or another module's, as it is. */
export function textRefField(module: string, refField: WriteFormField): WriteFormField {
  const only = Object.prototype.hasOwnProperty.call(WORDS_RELATED_MODULES, module) ? WORDS_RELATED_MODULES[module as SimpleModule] : undefined;
  if (!only || refField.kind !== 'related' || !refField.related) return refField;
  return { ...refField, related: { ...refField.related, modules: refField.related.modules.filter((m) => only.includes(m)) } };
}
