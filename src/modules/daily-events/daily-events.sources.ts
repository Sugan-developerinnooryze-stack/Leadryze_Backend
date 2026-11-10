import { Model } from 'mongoose';
import { DataScope } from '../../types';
import { applyDataScopeToFilter, applyDataScopeToCreatedByFilter } from '../native-crm/shared/data-scope';
import { BuiltInPipelineModule } from '../native-crm/pipeline-config/pipeline-config.model';
import { Meeting } from '../native-crm/meetings/meeting.model';
import { Call } from '../native-crm/calls/call.model';
import { Task } from '../native-crm/tasks/task.model';
import { Ticket } from '../native-crm/tickets/ticket.model';
import { NativeWorkorder } from '../native-crm/workorders/workorder.model';
import { NativeInvoice } from '../native-crm/invoices/invoice.model';
import { NativeContract } from '../native-crm/contracts/contract.model';
import { NativeQuotation } from '../native-crm/quotations/quotation.model';
import { Lead } from '../native-crm/leads/lead.model';
import { Deal } from '../native-crm/deals/deal.model';
import { NativeActivity } from '../native-crm/activities/activity.model';
import { DailyEventBucket, DailyEventCategory } from './daily-events.types';
import { DateRule } from './daily-events.time';

/** Name lookups resolved once per request (only when the caller may see
 * Customers / Staff); a missing entry means "show the business id instead". */
/** A lead's follow-ups are the open items of these modules linked to it —
 * a lead has no follow-up date of its own. */
export const LEAD_FOLLOW_UP_MODULES = ['meeting', 'call', 'task', 'activity'] as const;
export type LeadFollowUpModule = (typeof LEAD_FOLLOW_UP_MODULES)[number];

/** relatedModule values that point at a lead. */
export const LEAD_RELATED_MODULES = ['lead', 'leads'];

export function isLeadRelated(relatedModule: unknown): boolean {
  return typeof relatedModule === 'string' && LEAD_RELATED_MODULES.includes(relatedModule);
}

export interface NameLookups {
  customer: (customerId: unknown) => string | undefined;
  staff: (staffId: unknown) => string | undefined;
}

/** The record-specific parts of one event — everything else (date, time,
 * bucket, status, id) is filled in generically by the service. */
export interface EventParts {
  title: string;
  subtitle?: string;
  assignee?: string;
  related?: { module: string; label: string };
  endAt?: Date | null;
  link: { path: string; exact: boolean };
}

/** How a module's status field is read. Pipeline modules use the tenant's
 * own configured stages (isTerminal), fixed-enum modules list theirs here. */
export type StatusSpec =
  | { field: string; pipeline: BuiltInPipelineModule }
  | { field: string; terminal: string[]; cancelled: string[]; labels?: Record<string, string> };

export interface RecordSourceDef {
  module: string;
  label: string;
  source: 'native_crm' | 'field_service';
  category: DailyEventCategory;
  /** Tenant module flag — same key the module's own router checks. */
  flag: string;
  /** View permission — same key the module's own list route checks. */
  permission: string;
  model: Model<any>;
  dateField: string;
  /** How dateField becomes a calendar day (see DateRule). */
  dateRule: DateRule;
  /** The module's own list() applies req.branchId (Meetings/Calls have no branch). */
  branchScoped: boolean;
  /** Tenant.dataScopeConfig key, as passed to resolveEffectiveScope. */
  scopeKey: string;
  /** Applies DataScope exactly like the module's own list() does. */
  applyScope: (filter: Record<string, unknown>, scope: DataScope) => void;
  status: StatusSpec;
  /** Extra "still open" condition for overdue / upcoming (beyond status)… */
  openFilter?: Record<string, unknown>;
  /** …and the same test on a loaded record, for Today (which lists every status). */
  isOpen?: (doc: any) => boolean;
  buckets: DailyEventBucket[];
  /** What the date means; `open` = not in a finished status. */
  kind: (bucket: DailyEventBucket, doc: any, state: { now: Date; open: boolean }) => string;
  select: string;
  customerIds?: (doc: any) => unknown[];
  staffIds?: (doc: any) => unknown[];
  toEvent: (doc: any, names: NameLookups) => EventParts;
  note?: string;
}

const ALL_BUCKETS: DailyEventBucket[] = ['today', 'overdue', 'upcoming'];

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function joined(...parts: unknown[]): string | undefined {
  const out = parts.map(text).filter(Boolean);
  return out.length ? out.join(' · ') : undefined;
}

function capitalise(value: unknown): string | undefined {
  const t = text(value);
  return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : undefined;
}

function relatedOf(doc: any): EventParts['related'] {
  const module = text(doc.relatedModule);
  if (!module) return undefined;
  return { module, label: text(doc.relatedLabel) ?? capitalise(module)! };
}

function staffNames(ids: unknown[], names: NameLookups): string | undefined {
  const resolved = ids.map((id) => names.staff(id)).filter((n): n is string => !!n);
  return resolved.length ? Array.from(new Set(resolved)).join(', ') : undefined;
}

function customerLabel(doc: any, names: NameLookups): string | undefined {
  return names.customer(doc.customerId) ?? text(doc.customerId);
}

const createdByScope = (filter: Record<string, unknown>, scope: DataScope) => applyDataScopeToCreatedByFilter(filter, scope);

/** Order here is the order modules are listed inside each source. */
export const RECORD_SOURCES: RecordSourceDef[] = [
  /* ── Native CRM ─────────────────────────────────────────────────────── */
  {
    module: 'meeting', label: 'Meetings', source: 'native_crm', category: 'meeting',
    flag: 'native_meetings', permission: 'native_crm.meetings.view',
    model: Meeting, dateField: 'startDate', dateRule: 'instant', branchScoped: false,
    scopeKey: 'meetings', applyScope: (f, s) => applyDataScopeToFilter(f, s, 'assignedStaffId'),
    status: { field: 'meetingStatus', terminal: ['completed', 'cancelled'], cancelled: ['cancelled'] },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Not marked done' : 'Starts'),
    select: 'title startDate endDate location meetingStatus relatedModule relatedLabel assignedStaffName',
    toEvent: (d) => ({
      title: text(d.title) ?? 'Meeting',
      subtitle: text(d.location),
      assignee: text(d.assignedStaffName),
      related: relatedOf(d),
      endAt: d.endDate ?? null,
      link: { path: '/crm/meetings', exact: false },
    }),
  },
  {
    module: 'call', label: 'Calls', source: 'native_crm', category: 'call',
    flag: 'native_calls', permission: 'native_crm.calls.view',
    model: Call, dateField: 'date', dateRule: 'instantOrMidnight', branchScoped: false,
    scopeKey: 'calls', applyScope: createdByScope,
    status: { field: 'callStatus', terminal: ['completed', 'missed', 'cancelled'], cancelled: ['missed', 'cancelled'] },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Not marked done' : 'Call at'),
    select: 'contactName direction date callStatus relatedModule relatedLabel',
    toEvent: (d) => ({
      title: text(d.contactName) ? `Call with ${text(d.contactName)}` : 'Call',
      subtitle: d.direction ? `${capitalise(d.direction)} call` : undefined,
      related: relatedOf(d),
      link: { path: '/crm/calls', exact: false },
    }),
  },
  {
    module: 'task', label: 'Tasks', source: 'native_crm', category: 'task',
    flag: 'native_tasks', permission: 'native_crm.tasks.view',
    model: Task, dateField: 'dueDate', dateRule: 'date', branchScoped: true,
    scopeKey: 'tasks', applyScope: createdByScope,
    status: { field: 'taskStatus', pipeline: 'task' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Was due' : 'Due'),
    select: 'title dueDate priority taskStatus assignedTo relatedModule relatedLabel',
    staffIds: (d) => [d.assignedTo],
    toEvent: (d, names) => ({
      title: text(d.title) ?? 'Task',
      subtitle: d.priority ? `${capitalise(d.priority)} priority` : undefined,
      assignee: names.staff(d.assignedTo),
      related: relatedOf(d),
      link: { path: '/crm/tasks', exact: false },
    }),
  },
  {
    module: 'ticket', label: 'Tickets', source: 'native_crm', category: 'ticket',
    flag: 'native_tickets', permission: 'native_crm.tickets.view',
    model: Ticket, dateField: 'resolutionDueAt', dateRule: 'instant', branchScoped: true,
    scopeKey: 'tickets', applyScope: createdByScope,
    status: { field: 'ticketStatus', pipeline: 'ticket' },
    // Done = a finished stage (checked by the service) or the SLA service's
    // resolved / closed stamps.
    openFilter: { resolvedAt: null, closedAt: null },
    isOpen: (d) => !d.resolvedAt && !d.closedAt,
    buckets: ALL_BUCKETS,
    kind: (b, d, { now, open }) => {
      if (b === 'overdue') return 'SLA breached';
      return b === 'today' && open && d.resolutionDueAt && new Date(d.resolutionDueAt) < now ? 'SLA breached' : 'SLA due';
    },
    select: 'subject ticketNumber ticketId priority ticketStatus contactName resolutionDueAt resolvedAt closedAt relatedModule relatedLabel',
    toEvent: (d) => ({
      title: text(d.subject) ?? 'Ticket',
      subtitle: joined(d.ticketNumber ?? d.ticketId, d.priority ? `${capitalise(d.priority)} priority` : undefined, d.contactName),
      related: relatedOf(d),
      link: { path: `/crm/tickets/${d._id}`, exact: true },
    }),
  },

  /* ── Field Service ──────────────────────────────────────────────────── */
  {
    module: 'workorder', label: 'Work Orders', source: 'field_service', category: 'workorder',
    flag: 'fs_workorders', permission: 'fs.workorders.view',
    model: NativeWorkorder, dateField: 'scheduledDate', dateRule: 'instantOrMidnight', branchScoped: true,
    scopeKey: 'workorders', applyScope: (f, s) => applyDataScopeToFilter(f, s, 'staffIds'),
    status: { field: 'status', pipeline: 'workorder' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Was scheduled' : 'Scheduled'),
    select: 'title workOrderId customerId scheduledDate durationHours status staffId staffIds',
    customerIds: (d) => [d.customerId],
    staffIds: (d) => [...(d.staffIds ?? []), d.staffId],
    toEvent: (d, names) => ({
      title: text(d.title) ?? text(d.workOrderId) ?? 'Work order',
      subtitle: joined(d.workOrderId, customerLabel(d, names)),
      assignee: staffNames([...(d.staffIds ?? []), d.staffId], names),
      endAt: d.scheduledDate && d.durationHours ? new Date(new Date(d.scheduledDate).getTime() + d.durationHours * 3600_000) : null,
      link: { path: `/native-crm/workorders/${d._id}`, exact: true },
    }),
  },
  {
    module: 'invoice', label: 'Invoices', source: 'field_service', category: 'invoice',
    flag: 'fs_invoices', permission: 'fs.invoices.view',
    model: NativeInvoice, dateField: 'dueDate', dateRule: 'date', branchScoped: true,
    scopeKey: 'invoices', applyScope: createdByScope,
    status: { field: 'status', pipeline: 'invoice' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Payment overdue' : 'Payment due'),
    select: 'invoiceId customerId dueDate status',
    customerIds: (d) => [d.customerId],
    toEvent: (d, names) => ({
      title: text(d.invoiceId) ? `Invoice ${text(d.invoiceId)}` : 'Invoice',
      subtitle: customerLabel(d, names),
      link: { path: `/native-crm/invoices/${d._id}`, exact: true },
    }),
  },
  {
    module: 'contract', label: 'Contract end dates', source: 'field_service', category: 'contract',
    flag: 'fs_contracts', permission: 'fs.contracts.view',
    model: NativeContract, dateField: 'endDate', dateRule: 'date', branchScoped: true,
    scopeKey: 'contracts', applyScope: (f, s) => applyDataScopeToFilter(f, s, 'staffIds'),
    status: { field: 'status', pipeline: 'contract' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Ended, still open' : 'Contract ends'),
    select: 'title contractId customerId endDate status',
    customerIds: (d) => [d.customerId],
    toEvent: (d, names) => ({
      title: text(d.title) ?? text(d.contractId) ?? 'Contract',
      subtitle: joined(d.contractId, customerLabel(d, names)),
      link: { path: `/native-crm/contracts/${d._id}`, exact: true },
    }),
  },
  {
    module: 'quotation', label: 'Quotations', source: 'field_service', category: 'quotation',
    flag: 'fs_quotations', permission: 'fs.quotations.view',
    model: NativeQuotation, dateField: 'validUntil', dateRule: 'date', branchScoped: true,
    scopeKey: 'quotations', applyScope: createdByScope,
    status: { field: 'status', pipeline: 'quotation' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Validity ended' : 'Valid until'),
    select: 'title quotationId customerId validUntil status',
    customerIds: (d) => [d.customerId],
    toEvent: (d, names) => ({
      title: text(d.title) ?? text(d.quotationId) ?? 'Quotation',
      subtitle: joined(d.quotationId, customerLabel(d, names)),
      link: { path: `/native-crm/quotations/${d._id}`, exact: true },
    }),
  },
  {
    module: 'lead', label: 'Leads', source: 'field_service', category: 'lead',
    flag: 'fs_leads', permission: 'native_crm.leads.view',
    model: Lead, dateField: 'expectedCloseDate', dateRule: 'date', branchScoped: true,
    scopeKey: 'leads', applyScope: (f, s) => applyDataScopeToFilter(f, s, 'leadOwnerStaffId', undefined, undefined, 'createdBy'),
    status: { field: 'status', pipeline: 'lead' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Expected close passed' : 'Expected close'),
    // Name / company / id only — no registered PII field (email, phone,
    // address…) is ever selected, so nothing here needs masking.
    select: 'firstName lastName company leadId expectedCloseDate status leadOwnerStaffId',
    staffIds: (d) => [d.leadOwnerStaffId],
    toEvent: (d, names) => ({
      title: joined([text(d.firstName), text(d.lastName)].filter(Boolean).join(' ')) ?? text(d.company) ?? text(d.leadId) ?? 'Lead',
      subtitle: joined(d.company, d.leadId),
      assignee: names.staff(d.leadOwnerStaffId),
      link: { path: `/native-crm/leads?lead=${d._id}`, exact: true },
    }),
  },
  {
    module: 'deal', label: 'Deals', source: 'field_service', category: 'deal',
    flag: 'native_deals', permission: 'native_crm.deals.view',
    model: Deal, dateField: 'closeDate', dateRule: 'date', branchScoped: true,
    scopeKey: 'deals', applyScope: (f, s) => applyDataScopeToFilter(f, s, 'assignedStaffId', undefined, undefined, 'createdBy'),
    status: { field: 'stage', pipeline: 'deal' },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Close date passed' : 'Expected close'),
    select: 'title closeDate stage companyName contactName assignedStaffId',
    staffIds: (d) => [d.assignedStaffId],
    toEvent: (d, names) => ({
      title: text(d.title) ?? 'Deal',
      subtitle: joined(d.companyName, d.contactName),
      assignee: names.staff(d.assignedStaffId),
      link: { path: '/native-crm/deals', exact: false },
    }),
  },
  {
    module: 'activity', label: 'Activities', source: 'field_service', category: 'activity',
    flag: 'fs_activities', permission: 'fs.activities.view',
    model: NativeActivity, dateField: 'scheduledAt', dateRule: 'date', branchScoped: true,
    scopeKey: 'activities', applyScope: createdByScope,
    status: { field: 'status', terminal: ['completed', 'cancelled'], cancelled: ['cancelled'] },
    buckets: ALL_BUCKETS,
    kind: (b) => (b === 'overdue' ? 'Was scheduled' : 'Scheduled'),
    select: 'subject type scheduledAt status assignedTo relatedModule relatedLabel activityId',
    toEvent: (d) => ({
      title: text(d.subject) ?? 'Activity',
      subtitle: joined(capitalise(d.type), d.activityId),
      assignee: text(d.assignedTo),
      related: relatedOf(d),
      link: { path: '/native-crm/activities', exact: false },
    }),
  },
];

/** Contract service visits live inside each contract (visits[]), so they are
 * read by the service separately, under the same gates as Contracts. Only
 * contracts in the "active" stage are read: the visit scheduler skips every
 * other contract, so their visits never happen. */
export const CONTRACT_VISITS = {
  module: 'contract_visit',
  label: 'Contract visits',
  category: 'contract' as DailyEventCategory,
  flag: 'fs_contracts',
  permission: 'fs.contracts.view',
  scopeKey: 'contracts',
  buckets: ['today', 'upcoming'] as DailyEventBucket[],
  open: ['planned', 'scheduled'],
  cancelled: ['cancelled'],
};

/** Gates for the optional name lookups. Without them, records show the
 * business id (e.g. a work order's customer code) instead of a name. */
export const LOOKUP_GATES = {
  customer: { flag: 'fs_customers', permission: 'fs.customers.view' },
  staff: { flag: 'fs_staffs', permission: 'fs.staffs.view' },
};

export const NOT_INCLUDED: string[] = [
  'Contacts, Companies, Customers and Sites have no date fields, so they never appear here.',
  'Leads have no follow-up date. Tasks, calls, meetings and activities linked to a lead are tagged "Lead follow-up" instead.',
  'Missed contract visits are not listed as overdue; the work orders generated from them are.',
  'Connector data is as of the last sync (about every 30 minutes) and cannot be narrowed by owner or branch.',
  'Manual calendar events and My CRM activities are not included yet.',
];
