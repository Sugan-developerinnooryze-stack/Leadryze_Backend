import { listCustomFields } from '../custom-fields/custom-field.service';
import { getTeamSiteStaffOptions, getCustomerOptions, getStatusOptions } from '../shared/lookup-options';
import { FilterFieldDef, customFieldFilterType } from '../shared/dynamic-filter';

const CONTRACT_TYPE_OPTIONS = [
  'amc', 'maintenance', 'rental', 'warranty', 'preventive', 'corrective', 'installation', 'inspection', 'custom',
].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical']
  .map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));

const RENEWAL_TYPE_OPTIONS = [
  { value: 'manual', label: 'Manual' }, { value: 'automatic', label: 'Automatic' },
];

const WO_GENERATION_MODE_OPTIONS = [
  { value: 'manual', label: 'Manual' }, { value: 'on_visit_day', label: 'On Visit Day' }, { value: 'days_before', label: 'Days Before' },
];

const RECURRING_UNIT_LABELS: Record<string, string> = {
  day: 'Day', week: 'Week', fortnight: 'Fortnight', month: 'Month', bimonthly: 'Bi-Monthly',
  quarter: 'Quarter', halfyear: 'Half Year', year: 'Year', custom: 'Custom',
};
const RECURRING_UNIT_OPTIONS = Object.entries(RECURRING_UNIT_LABELS).map(([value, label]) => ({ value, label }));

const WORKFLOW_STATE_OPTIONS = [
  { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }, { value: 'complete', label: 'Complete' },
];

/** Contracts carry the largest schema of the 4 document modules (the master
 * schedule engine — renewal, recurring generation, visit tracking) on top
 * of the same Site/Team/Staff/Discount/GST/Total fields Quotations/Work
 * Orders/Invoices already have, so this catalog is deliberately the fullest
 * one. Fields already covered by this page's own dedicated controls (search
 * = title/customerId, status dropdown = status, Date button = createdAt,
 * Company tabs = branchId) are excluded, same rule as every other module. */
async function getFixedFilterFields(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [{ teamOptions, siteOptions, staffOptions }, customerOptions, statusOptions] = await Promise.all([
    getTeamSiteStaffOptions(tenantId, branchId),
    getCustomerOptions(tenantId, branchId),
    getStatusOptions(tenantId, 'contract'),
  ]);

  return [
    { key: 'customerId',            label: 'Customer',          type: 'select',  path: 'customerId',            options: customerOptions, source: 'fixed' },
    { key: 'status',                label: 'Status',            type: 'select',  path: 'status',                options: statusOptions, source: 'fixed' },
    { key: 'siteId',                label: 'Site',              type: 'select',  path: 'siteId',                options: siteOptions, source: 'fixed' },
    { key: 'teamId',                label: 'Team',              type: 'select',  path: 'teamId',                options: teamOptions, source: 'fixed' },
    { key: 'staffId',               label: 'Assigned Staff',    type: 'multi',   path: 'staffId', arrayPath: 'staffIds', options: staffOptions, source: 'fixed' },
    { key: 'address',               label: 'Address',           type: 'text',    path: 'address',               source: 'fixed' },
    { key: 'notes',                 label: 'Notes',             type: 'text',    path: 'notes',                 source: 'fixed' },
    { key: 'clientId',              label: 'Client ID',         type: 'text',    path: 'clientId',              source: 'fixed' },
    { key: 'contractType',          label: 'Contract Type',     type: 'select',  path: 'contractType',          options: CONTRACT_TYPE_OPTIONS, source: 'fixed' },
    { key: 'priority',              label: 'Priority',          type: 'select',  path: 'priority',              options: PRIORITY_OPTIONS, source: 'fixed' },
    { key: 'workflowState',         label: 'Workflow State',    type: 'select',  path: 'workflowState',         options: WORKFLOW_STATE_OPTIONS, source: 'fixed' },
    { key: 'startDate',             label: 'Start Date',        type: 'date',    path: 'startDate',             source: 'fixed' },
    { key: 'endDate',               label: 'End Date',          type: 'date',    path: 'endDate',               source: 'fixed' },
    { key: 'noEndDate',             label: 'No End Date',       type: 'boolean', path: 'noEndDate',             source: 'fixed' },
    { key: 'nextServiceDate',       label: 'Next Service Date', type: 'date',    path: 'nextServiceDate',       source: 'fixed' },
    { key: 'lastServiceDate',       label: 'Last Service Date', type: 'date',    path: 'lastServiceDate',       source: 'fixed' },
    { key: 'renewalType',           label: 'Renewal Type',      type: 'select',  path: 'renewalType',           options: RENEWAL_TYPE_OPTIONS, source: 'fixed' },
    { key: 'renewBeforeDays',       label: 'Renew Before (days)', type: 'number', path: 'renewBeforeDays',      source: 'fixed' },
    { key: 'woGenerationMode',      label: 'WO Generation Mode', type: 'select', path: 'woGenerationMode',      options: WO_GENERATION_MODE_OPTIONS, source: 'fixed' },
    { key: 'woLeadDays',            label: 'WO Lead (days)',    type: 'number',  path: 'woLeadDays',            source: 'fixed' },
    { key: 'autoWoGenerated',       label: 'Auto WOs Generated', type: 'number', path: 'autoWoGenerated',       source: 'fixed' },
    { key: 'recurringUnit',         label: 'Recurring Unit',    type: 'select',  path: 'recurringUnit',         options: RECURRING_UNIT_OPTIONS, source: 'fixed' },
    { key: 'recurringInterval',     label: 'Recurring Interval', type: 'number', path: 'recurringInterval',     source: 'fixed' },
    { key: 'serviceFrequency',      label: 'Service Frequency', type: 'text',    path: 'serviceFrequency',      source: 'fixed' },
    { key: 'discount',              label: 'Discount',          type: 'number',  path: 'discount',              source: 'fixed' },
    { key: 'gstPercentage',         label: 'GST %',             type: 'number',  path: 'gstPercentage',         source: 'fixed' },
    { key: 'partsAmount',           label: 'Parts Amount',      type: 'number',  path: 'partsAmount',           source: 'fixed' },
    { key: 'servicesAmount',        label: 'Services Amount',   type: 'number',  path: 'servicesAmount',        source: 'fixed' },
    { key: 'servicesAmountWithTax', label: 'Total',             type: 'number',  path: 'servicesAmountWithTax', source: 'fixed' },
    { key: 'isLocked',              label: 'Locked',            type: 'boolean', path: 'isLocked',              source: 'fixed' },
  ];
}

/** Fixed catalog + this tenant's currently-active custom fields for the
 * "contracts" module — a custom field added later shows up here
 * automatically, no code change needed. */
export async function getContractFilterCatalog(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [fixed, customFields] = await Promise.all([
    getFixedFilterFields(tenantId, branchId),
    listCustomFields(tenantId, 'contracts', branchId ?? null),
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
