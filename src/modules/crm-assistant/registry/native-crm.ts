import type { FieldCap, FieldKind, ModuleCap } from './types';
import { ROUTE_TEMPLATES } from '../contracts/routes';
import { Company } from '../../native-crm/companies/company.model';
import { Contact } from '../../native-crm/contacts/contact.model';
import { Task } from '../../native-crm/tasks/task.model';
import { Ticket } from '../../native-crm/tickets/ticket.model';
import { Call } from '../../native-crm/calls/call.model';
import { Meeting } from '../../native-crm/meetings/meeting.model';

/* Modules the sidebar shows under "Native CRM" (ai/src/tools/crm/
 * module-map.ts crmSourceFor): companies, contacts, tasks, tickets, calls and
 * meetings. Same tier rules as field-service.ts: 'list' and 'detail' fields
 * are only ones the gateway's read projection keeps, 'hidden' fields drive
 * the engine and are never shown, and every other schema path is in
 * ignoredPaths with its reason. */

type Read = FieldCap['read'];
type Ignored = ModuleCap['ignoredPaths'];

const f = (path: string, label: string, kind: FieldKind, read: Read, extra: Partial<FieldCap> = {}): FieldCap =>
  ({ key: path, path, label, kind, read, ...extra });
const col = (priority: 1 | 2 | 3): Partial<FieldCap> => ({ priority });
const created = (read: Read): FieldCap => f('createdAt', 'Created', 'datetime', read, { dateRule: 'instant' });
const updated = (): FieldCap => f('updatedAt', 'Updated', 'datetime', 'detail', { dateRule: 'instant' });
const fromSchema: Partial<FieldCap> = { enumFrom: 'schema' };

/** Paths every Native CRM model carries that are never offered (Companies,
 * Calls and Meetings have no branchId and Tickets no notes; see each entry). */
const BASE: Ignored = {
  _id: 'system', __v: 'system', tenantId: 'system', clientId: 'internal', createdBy: 'system',
  customFields: 'detail_only', tags: 'detail_only',
};
const LOCKS: Ignored = { isLocked: 'system', lockedAt: 'system', lockedBy: 'system', lockReason: 'system' };
/** CRM-assistant reminder-pause markers (shared/assistant-provenance.ts). */
const ASSISTANT_MARKERS: Ignored = { assistantChangedAt: 'system', assistantFingerprint: 'system' };

const company: ModuleCap = {
  key: 'company',
  group: 'native_crm',
  labels: {
    singular: 'Company', plural: 'Companies',
    synonyms: ['company', 'companies', 'organisation', 'organisations', 'organization', 'organizations'],
  },
  gate: { flagKey: 'native_companies', permPrefix: 'native_crm.companies', scopeKey: 'companies' },
  model: () => Company,
  ids: { businessUnique: false, title: ['name'] },
  stage: { field: 'companyStatus', enumFrom: 'schema', terminal: ['inactive'] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('name', 'Name', 'text', 'list', col(1)),
    f('companyStatus', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('industry', 'Industry', 'text', 'list', col(2)),
    f('city', 'City', 'text', 'list', col(2)),
    f('domain', 'Domain', 'text', 'list', col(3)),
    f('phone', 'Phone', 'phone', 'detail'),
    f('employeeCount', 'Employees', 'number', 'detail'),
    f('country', 'Country', 'text', 'detail'),
    created('hidden'),
  ],
  ignoredPaths: { ...BASE, notes: 'detail_only', website: 'detail_only', updatedAt: 'system' },
  routes: ROUTE_TEMPLATES.company,
};

const contact: ModuleCap = {
  key: 'contact',
  group: 'native_crm',
  labels: { singular: 'Contact', plural: 'Contacts', synonyms: ['contact', 'contacts', 'crm contact', 'crm contacts'] },
  gate: { flagKey: 'native_contacts', permPrefix: 'native_crm.contacts', scopeKey: 'contacts' },
  model: () => Contact,
  ids: { businessUnique: false, title: ['firstName lastName', 'company'] },
  stage: { field: 'status', enumFrom: 'schema', terminal: [] },
  dates: { default: 'createdAt', created: 'createdAt' },
  mine: { kind: 'contact_owner' },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: {
    default: { by: 'createdAt', dir: 'desc' },
    listSortable: ['firstName', 'lastName', 'company', 'jobTitle', 'status', 'source', 'createdAt'],
  },
  fields: [
    f('firstName', 'First name', 'text', 'list', col(1)),
    f('lastName', 'Last name', 'text', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('company', 'Company', 'text', 'list', col(2)),
    f('jobTitle', 'Job title', 'text', 'list', col(2)),
    f('email', 'Email', 'email', 'detail', { pii: { module: 'contacts', encrypted: true, blindIndex: 'emailSearch' } }),
    f('phone', 'Phone', 'phone', 'detail', { pii: { module: 'contacts', encrypted: true, blindIndex: 'phoneSearch' } }),
    f('source', 'Source', 'enum', 'detail', fromSchema),
    // userId, "First Last" or the user's name (contact.service.ts listContacts).
    f('contactOwner', 'Owner', 'text', 'hidden'),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS, branchId: 'system', notes: 'detail_only',
    phoneSearch: 'secret', emailDomain: 'secret', emailSearch: 'secret',
    companyId: 'detail_only', lifecycleStage: 'detail_only', leadStatus: 'detail_only', leadId: 'detail_only',
    updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.contact,
};

const task: ModuleCap = {
  key: 'task',
  group: 'native_crm',
  labels: { singular: 'Task', plural: 'Tasks', synonyms: ['task', 'tasks', 'to-do', 'to-dos', 'todo', 'todos'] },
  gate: { flagKey: 'native_tasks', permPrefix: 'native_crm.tasks', scopeKey: 'tasks' },
  model: () => Task,
  ids: { businessUnique: false, title: ['title'] },
  stage: { field: 'taskStatus', pipeline: 'task' },
  dates: { default: 'dueDate', created: 'createdAt', due: 'dueDate' },
  // The app's own "My Tasks" tab means created by me (D3); "assigned to me"
  // is the assignee's staff id.
  mine: { kind: 'owner_ids', field: 'assignedTo', match: ['ownStaffId'] },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'dueDate', dir: 'asc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('taskStatus', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'task' } }),
    f('dueDate', 'Due', 'date', 'list', { ...col(2), dateRule: 'date' }),
    f('priority', 'Priority', 'enum', 'list', { ...col(2), ...fromSchema }),
    f('assignedTo', 'Assigned to', 'ref', 'list', { ...col(3), ref: { module: 'staff', targetField: 'staffId', idFormat: 'business' } }),
    f('relatedModule', 'Related to', 'enum', 'detail', fromSchema),
    f('relatedLabel', 'Related record', 'text', 'detail'),
    created('detail'),
    updated(),
    f('relatedId', 'Related record ID', 'text', 'hidden'),
  ],
  ignoredPaths: {
    ...BASE, ...ASSISTANT_MARKERS, branchId: 'system', notes: 'detail_only', reminderSentAt: 'internal',
    reminderSuppressedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.task,
};

const ticket: ModuleCap = {
  key: 'ticket',
  group: 'native_crm',
  labels: { singular: 'Ticket', plural: 'Tickets', synonyms: ['ticket', 'tickets', 'support ticket', 'support tickets'] },
  gate: { flagKey: 'native_tickets', permPrefix: 'native_crm.tickets', scopeKey: 'tickets' },
  model: () => Ticket,
  ids: { business: 'ticketNumber', businessUnique: false, title: ['subject'] },
  stage: { field: 'ticketStatus', pipeline: 'ticket' },
  dates: { default: 'createdAt', created: 'createdAt', due: 'resolutionDueAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('subject', 'Subject', 'text', 'list', col(1)),
    f('ticketStatus', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'ticket' } }),
    f('ticketNumber', 'Ticket', 'id', 'list', col(2)),
    f('priority', 'Priority', 'enum', 'list', { ...col(2), ...fromSchema }),
    f('contactName', 'Contact', 'text', 'list', col(3)),
    f('resolutionDueAt', 'Resolution due', 'datetime', 'list', { ...col(3), dateRule: 'instant' }),
    // Not stored: listTickets/getTicketById derive it from the SLA dates.
    f('slaStatus', 'SLA', 'text', 'detail', { virtual: true }),
    f('firstResponseDueAt', 'First response due', 'datetime', 'detail', { dateRule: 'instant' }),
    f('resolvedAt', 'Resolved', 'datetime', 'detail', { dateRule: 'instant' }),
    f('closedAt', 'Closed', 'datetime', 'detail', { dateRule: 'instant' }),
    f('relatedModule', 'Related to', 'enum', 'detail', fromSchema),
    f('relatedLabel', 'Related record', 'text', 'detail'),
    created('detail'),
    updated(),
  ],
  ignoredPaths: {
    ...BASE, ...ASSISTANT_MARKERS, branchId: 'system', numId: 'internal',
    ticketId: 'internal', description: 'detail_only', relatedId: 'internal',
    resolutionWarningAt: 'internal', firstResponseWarningAt: 'internal', firstRespondedAt: 'detail_only',
  },
  routes: ROUTE_TEMPLATES.ticket,
};

const call: ModuleCap = {
  key: 'call',
  group: 'native_crm',
  labels: {
    singular: 'Call', plural: 'Calls',
    synonyms: ['call', 'calls', 'phone call', 'phone calls', 'call log', 'call logs'],
  },
  gate: { flagKey: 'native_calls', permPrefix: 'native_crm.calls', scopeKey: 'calls' },
  model: () => Call,
  ids: { businessUnique: false, title: ['contactName'] },
  stage: { field: 'callStatus', enumFrom: 'schema', terminal: ['completed', 'missed', 'cancelled'] },
  dates: { default: 'date', created: 'createdAt', start: 'date' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'date', dir: 'desc' }, listSortable: [] },
  fields: [
    f('contactName', 'Contact', 'text', 'list', col(1)),
    f('callStatus', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('date', 'Date', 'datetime', 'list', { ...col(2), dateRule: 'instantOrMidnight' }),
    f('direction', 'Direction', 'enum', 'list', { ...col(2), ...fromSchema }),
    f('duration', 'Duration', 'duration', 'list', { ...col(3), unit: 'seconds', unitUncertain: true }),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, ...ASSISTANT_MARKERS, notes: 'detail_only', timezone: 'internal', relatedModule: 'detail_only', relatedId: 'detail_only',
    relatedLabel: 'detail_only', reminderSentAt: 'internal', reminderSuppressedAt: 'system', updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.call,
};

const meeting: ModuleCap = {
  key: 'meeting',
  group: 'native_crm',
  labels: { singular: 'Meeting', plural: 'Meetings', synonyms: ['meeting', 'meetings', 'appointment', 'appointments'] },
  gate: { flagKey: 'native_meetings', permPrefix: 'native_crm.meetings', scopeKey: 'meetings' },
  model: () => Meeting,
  ids: { businessUnique: false, title: ['title'] },
  stage: { field: 'meetingStatus', enumFrom: 'schema', terminal: ['completed', 'cancelled'] },
  dates: { default: 'startDate', created: 'createdAt', start: 'startDate', end: 'endDate' },
  mine: { kind: 'owner_ids', field: 'assignedStaffId', match: ['ownStaffId'] },
  createdByRecorded: false,
  search: { delegateToList: true, escapeAtCallSite: false },
  sort: { default: { by: 'startDate', dir: 'asc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('meetingStatus', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('startDate', 'Starts', 'datetime', 'list', { ...col(2), dateRule: 'instant' }),
    f('endDate', 'Ends', 'datetime', 'list', { ...col(3), dateRule: 'instant' }),
    f('assignedStaffId', 'Assigned staff', 'ref', 'detail', { ref: { module: 'staff', targetField: 'staffId', idFormat: 'business' } }),
    created('hidden'),
  ],
  ignoredPaths: {
    ...BASE, notes: 'detail_only', timezone: 'internal',
    // 'location' is a READ_FORBIDDEN_KEYS name (crm-read.service.ts), so the
    // meeting's place is never offered even though the module map lists it.
    location: 'detail_only', attendees: 'detail_only', relatedModule: 'detail_only', relatedId: 'detail_only',
    relatedLabel: 'detail_only', reminderSentAt: 'internal', assignedStaffName: 'detail_only', source: 'internal',
    teamId: 'detail_only', teamName: 'detail_only', updatedAt: 'system',
  },
  routes: ROUTE_TEMPLATES.meeting,
};

/** Native CRM modules (sidebar group "Native CRM"). */
export const NATIVE_CRM_CAPS: ModuleCap[] = [company, contact, task, ticket, call, meeting];
