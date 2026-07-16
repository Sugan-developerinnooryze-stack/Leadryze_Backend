export type NativeModule = 'contacts' | 'companies' | 'deals' | 'tasks' | 'tickets' | 'calls' | 'meetings';

export interface FieldDef {
  key:          string;
  label:        string;
  type:         'text' | 'email' | 'phone' | 'number' | 'date' | 'datetime' | 'select' | 'textarea' | 'currency';
  required?:    boolean;
  options?:     string[];
  placeholder?: string;
}

export interface ModuleConfig {
  label:         string;
  labelSingular: string;
  statusField?:  string;
  defaultStatus: string;
  fields:        FieldDef[];
  listColumns:   string[];
  displayNameFn: (fields: Record<string, unknown>) => string;
}

export const NATIVE_MODULES: NativeModule[] = [
  'contacts', 'companies', 'deals', 'tasks', 'tickets', 'calls', 'meetings',
];

export const MODULE_CONFIGS: Record<NativeModule, ModuleConfig> = {
  contacts: {
    label:         'Contacts',
    labelSingular: 'Contact',
    statusField:   'status',
    defaultStatus: 'lead',
    listColumns:   ['email', 'phone', 'company', 'status'],
    displayNameFn: (f) => [f.firstName, f.lastName].filter(Boolean).join(' ') || String(f.email || 'Unnamed'),
    fields: [
      { key: 'firstName',  label: 'First Name',  type: 'text',     required: true },
      { key: 'lastName',   label: 'Last Name',   type: 'text',     required: true },
      { key: 'email',      label: 'Email',       type: 'email',    required: true },
      { key: 'phone',      label: 'Phone',       type: 'phone' },
      { key: 'company',    label: 'Company',     type: 'text' },
      { key: 'jobTitle',   label: 'Job Title',   type: 'text' },
      { key: 'status',     label: 'Status',      type: 'select',   options: ['lead', 'contact', 'customer'] },
      { key: 'source',     label: 'Lead Source', type: 'select',   options: ['website', 'referral', 'social', 'email', 'cold', 'other'] },
      { key: 'notes',      label: 'Notes',       type: 'textarea' },
    ],
  },

  companies: {
    label:         'Companies',
    labelSingular: 'Company',
    statusField:   'companyStatus',
    defaultStatus: 'active',
    listColumns:   ['domain', 'industry', 'city', 'companyStatus'],
    displayNameFn: (f) => String(f.name || 'Unnamed Company'),
    fields: [
      { key: 'name',          label: 'Company Name',     type: 'text',     required: true },
      { key: 'domain',        label: 'Website / Domain', type: 'text',     placeholder: 'company.com' },
      { key: 'industry',      label: 'Industry',         type: 'select',   options: ['Technology', 'Finance', 'Healthcare', 'Education', 'Manufacturing', 'Retail', 'Real Estate', 'Media', 'Consulting', 'Other'] },
      { key: 'employeeCount', label: 'Employees',        type: 'number' },
      { key: 'phone',         label: 'Phone',            type: 'phone' },
      { key: 'city',          label: 'City',             type: 'text' },
      { key: 'country',       label: 'Country',          type: 'text' },
      { key: 'companyStatus', label: 'Status',           type: 'select',   options: ['active', 'inactive', 'prospect'] },
      { key: 'notes',         label: 'Notes',            type: 'textarea' },
    ],
  },

  deals: {
    label:         'Deals',
    labelSingular: 'Deal',
    statusField:   'stage',
    defaultStatus: 'prospect',
    listColumns:   ['amount', 'stage', 'closeDate', 'contactName'],
    displayNameFn: (f) => String(f.title || 'Untitled Deal'),
    fields: [
      { key: 'title',       label: 'Deal Title',   type: 'text',     required: true },
      { key: 'amount',      label: 'Amount',       type: 'currency' },
      { key: 'currency',    label: 'Currency',     type: 'select',   options: ['USD', 'EUR', 'INR', 'GBP', 'AED', 'SGD'] },
      { key: 'stage',       label: 'Stage',        type: 'select',   required: true, options: ['prospect', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] },
      { key: 'closeDate',   label: 'Close Date',   type: 'date' },
      { key: 'contactName', label: 'Contact',      type: 'text',     placeholder: 'Linked contact name' },
      { key: 'notes',       label: 'Notes',        type: 'textarea' },
    ],
  },

  tasks: {
    label:         'Tasks',
    labelSingular: 'Task',
    statusField:   'taskStatus',
    defaultStatus: 'todo',
    listColumns:   ['dueDate', 'priority', 'taskStatus', 'assignedTo'],
    displayNameFn: (f) => String(f.title || 'Untitled Task'),
    fields: [
      { key: 'title',       label: 'Task Title',  type: 'text',     required: true },
      { key: 'dueDate',     label: 'Due Date',    type: 'date',     required: true },
      { key: 'priority',    label: 'Priority',    type: 'select',   options: ['low', 'medium', 'high'] },
      { key: 'taskStatus',  label: 'Status',      type: 'select',   options: ['todo', 'in_progress', 'done', 'cancelled'] },
      { key: 'assignedTo',  label: 'Assigned To', type: 'text' },
      { key: 'notes',       label: 'Notes',       type: 'textarea' },
    ],
  },

  tickets: {
    label:         'Tickets',
    labelSingular: 'Ticket',
    statusField:   'ticketStatus',
    defaultStatus: 'open',
    listColumns:   ['priority', 'ticketStatus'],
    displayNameFn: (f) => String(f.subject || 'Untitled Ticket'),
    fields: [
      { key: 'subject',       label: 'Subject',     type: 'text',     required: true },
      { key: 'priority',      label: 'Priority',    type: 'select',   options: ['low', 'medium', 'high', 'critical'] },
      { key: 'ticketStatus',  label: 'Status',      type: 'select',   options: ['open', 'in_progress', 'resolved', 'closed'] },
      { key: 'description',   label: 'Description', type: 'textarea' },
    ],
  },

  calls: {
    label:         'Calls',
    labelSingular: 'Call',
    statusField:   'callStatus',
    defaultStatus: 'planned',
    listColumns:   ['direction', 'duration', 'callStatus', 'date'],
    displayNameFn: (f) => String(f.contactName || 'Unknown Contact'),
    fields: [
      { key: 'contactName', label: 'Contact Name', type: 'text',     required: true },
      { key: 'direction',   label: 'Direction',    type: 'select',   options: ['inbound', 'outbound'] },
      { key: 'duration',    label: 'Duration (min)', type: 'number' },
      { key: 'callStatus',  label: 'Status',       type: 'select',   options: ['planned', 'completed', 'missed', 'cancelled'] },
      { key: 'date',        label: 'Date & Time',  type: 'datetime' },
      { key: 'notes',       label: 'Notes',        type: 'textarea' },
    ],
  },

  meetings: {
    label:         'Meetings',
    labelSingular: 'Meeting',
    statusField:   'meetingStatus',
    defaultStatus: 'scheduled',
    listColumns:   ['startDate', 'endDate', 'location', 'meetingStatus'],
    displayNameFn: (f) => String(f.title || 'Untitled Meeting'),
    fields: [
      { key: 'title',          label: 'Meeting Title', type: 'text',     required: true },
      { key: 'startDate',      label: 'Start',         type: 'datetime' },
      { key: 'endDate',        label: 'End',           type: 'datetime' },
      { key: 'location',       label: 'Location',      type: 'text' },
      { key: 'attendees',      label: 'Attendees',     type: 'text',     placeholder: 'Comma-separated names or emails' },
      { key: 'meetingStatus',  label: 'Status',        type: 'select',   options: ['scheduled', 'completed', 'cancelled'] },
      { key: 'notes',          label: 'Notes',         type: 'textarea' },
    ],
  },
};
