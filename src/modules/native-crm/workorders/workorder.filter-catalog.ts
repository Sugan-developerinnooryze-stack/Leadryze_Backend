import { listCustomFields } from '../custom-fields/custom-field.service';
import { getTeamSiteStaffOptions, getCustomerOptions, getStatusOptions } from '../shared/lookup-options';
import { FilterFieldDef, customFieldFilterType } from '../shared/dynamic-filter';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
];
const WORKFLOW_STATE_OPTIONS = [
  { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }, { value: 'complete', label: 'Complete' },
];

/** Fields not already covered by this page's own dedicated controls
 * (search box = title/customerId text search, status dropdown = status,
 * the Date button = createdAt, the Company tabs = branchId) — this catalog
 * is deliberately everything ELSE on a Work Order that's worth filtering.
 * Team/Site/Assigned Staff are lookup-backed fields (same lookupModule
 * config as the create/edit form uses) — their `options` are real records,
 * not placeholder strings, so the picker shows actual names while still
 * filtering on the record's real stored id. */
async function getFixedFilterFields(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [{ teamOptions, siteOptions, staffOptions }, customerOptions, statusOptions] = await Promise.all([
    getTeamSiteStaffOptions(tenantId, branchId),
    getCustomerOptions(tenantId, branchId),
    getStatusOptions(tenantId, 'workorder'),
  ]);

  return [
    { key: 'workOrderId',   label: 'ID',              type: 'text',    path: 'workOrderId',   source: 'fixed' },
    { key: 'title',         label: 'Title',           type: 'text',    path: 'title',         source: 'fixed' },
    { key: 'customerId',    label: 'Customer',        type: 'select',  path: 'customerId',    options: customerOptions, source: 'fixed' },
    { key: 'status',        label: 'Status',          type: 'select',  path: 'status',        options: statusOptions, source: 'fixed' },
    { key: 'priority',      label: 'Priority',        type: 'select',  path: 'priority',      options: PRIORITY_OPTIONS,       source: 'fixed' },
    { key: 'workflowState', label: 'Workflow State',  type: 'select',  path: 'workflowState', options: WORKFLOW_STATE_OPTIONS, source: 'fixed' },
    { key: 'siteId',        label: 'Site',            type: 'select',  path: 'siteId',        options: siteOptions, source: 'fixed' },
    { key: 'teamId',        label: 'Team',            type: 'select',  path: 'teamId',        options: teamOptions, source: 'fixed' },
    { key: 'staffId',       label: 'Assigned Staff',  type: 'multi',   path: 'staffId', arrayPath: 'staffIds', options: staffOptions, source: 'fixed' },
    { key: 'address',       label: 'Address',         type: 'text',    path: 'address',       source: 'fixed' },
    { key: 'notes',         label: 'Notes',           type: 'text',    path: 'notes',         source: 'fixed' },
    { key: 'clientId',      label: 'Client ID',       type: 'text',    path: 'clientId',      source: 'fixed' },
    { key: 'scheduledDate', label: 'Scheduled Date',  type: 'date',    path: 'scheduledDate', source: 'fixed' },
    { key: 'completedDate', label: 'Completed Date',  type: 'date',    path: 'completedDate', source: 'fixed' },
    { key: 'durationHours', label: 'Duration (hrs)',  type: 'number',  path: 'durationHours', source: 'fixed' },
    { key: 'discount',      label: 'Discount',        type: 'number',  path: 'discount',      source: 'fixed' },
    { key: 'gstPercentage', label: 'GST %',           type: 'number',  path: 'gstPercentage', source: 'fixed' },
    { key: 'isLocked',      label: 'Locked',          type: 'boolean', path: 'isLocked',      source: 'fixed' },
  ];
}

/** Fixed catalog + this tenant's currently-active custom fields for the
 * "workorders" module (same module key FSDrawer's create/edit form already
 * uses) — a custom field a Tenant Admin adds tomorrow shows up here
 * automatically on next fetch, no code change needed on either side. */
export async function getWorkorderFilterCatalog(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [fixed, customFields] = await Promise.all([
    getFixedFilterFields(tenantId, branchId),
    listCustomFields(tenantId, 'workorders', branchId ?? null),
  ]);
  const custom: FilterFieldDef[] = [];
  for (const f of customFields) {
    const type = customFieldFilterType(f.fieldType);
    if (!type) continue;
    custom.push({
      key:     `cf:${f.fieldKey}`,
      label:   f.label,
      type,
      path:    `customFields.${f.fieldKey}`,
      options: f.options?.map((opt) => ({ value: opt, label: opt })),
      source:  'custom',
    });
  }
  return [...fixed, ...custom];
}
