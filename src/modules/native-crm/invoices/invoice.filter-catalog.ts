import { listCustomFields } from '../custom-fields/custom-field.service';
import { getCustomerOptions, getStatusOptions } from '../shared/lookup-options';
import { FilterFieldDef, customFieldFilterType } from '../shared/dynamic-filter';

const WORKFLOW_STATE_OPTIONS = [
  { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }, { value: 'complete', label: 'Complete' },
];

/** Mirrors the exact set of real, populated fields FSTable's own "Edit
 * Columns" shows for this page (explicit columns + auto-derived raw record
 * keys) — Created Date and Company are the two deliberate exceptions,
 * already covered by a dedicated, better control elsewhere on this page
 * (the Date button, the Company tabs). Invoices carry no siteId/teamId/
 * staffId of their own (unlike Quotations/Contracts/Work Orders) — an
 * Invoice inherits its source's staffing, it isn't independently assigned. */
async function getFixedFilterFields(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [customerOptions, statusOptions] = await Promise.all([
    getCustomerOptions(tenantId, branchId),
    getStatusOptions(tenantId, 'invoice'),
  ]);

  return [
    { key: 'invoiceId',             label: 'ID',               type: 'text',    path: 'invoiceId',             source: 'fixed' },
    { key: 'customerId',            label: 'Customer',         type: 'select',  path: 'customerId',            options: customerOptions, source: 'fixed' },
    { key: 'status',                label: 'Status',           type: 'select',  path: 'status',                options: statusOptions, source: 'fixed' },
    { key: 'workflowState',         label: 'Workflow State',   type: 'select',  path: 'workflowState',         options: WORKFLOW_STATE_OPTIONS, source: 'fixed' },
    { key: 'address',               label: 'Address',          type: 'text',    path: 'address',               source: 'fixed' },
    { key: 'notes',                 label: 'Notes',            type: 'text',    path: 'notes',                 source: 'fixed' },
    { key: 'clientId',              label: 'Client ID',        type: 'text',    path: 'clientId',              source: 'fixed' },
    { key: 'workOrderId',           label: 'Work Order ID',    type: 'text',    path: 'workOrderId',           source: 'fixed' },
    { key: 'quotationId',           label: 'Quotation ID',     type: 'text',    path: 'quotationId',           source: 'fixed' },
    { key: 'contractId',            label: 'Contract ID',      type: 'text',    path: 'contractId',            source: 'fixed' },
    { key: 'dueDate',               label: 'Due Date',         type: 'date',    path: 'dueDate',               source: 'fixed' },
    { key: 'paid',                  label: 'Paid',             type: 'boolean', path: 'paid',                  source: 'fixed' },
    { key: 'discount',              label: 'Discount',         type: 'number',  path: 'discount',              source: 'fixed' },
    { key: 'gstPercentage',         label: 'GST %',            type: 'number',  path: 'gstPercentage',         source: 'fixed' },
    { key: 'partsAmount',           label: 'Parts Amount',     type: 'number',  path: 'partsAmount',           source: 'fixed' },
    { key: 'servicesAmount',        label: 'Services Amount',  type: 'number',  path: 'servicesAmount',        source: 'fixed' },
    { key: 'servicesAmountWithTax', label: 'Total',            type: 'number',  path: 'servicesAmountWithTax', source: 'fixed' },
    { key: 'isLocked',              label: 'Locked',           type: 'boolean', path: 'isLocked',              source: 'fixed' },
  ];
}

/** Fixed catalog + this tenant's currently-active custom fields for the
 * "invoices" module — a custom field added later shows up here
 * automatically, no code change needed. */
export async function getInvoiceFilterCatalog(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [fixed, customFields] = await Promise.all([
    getFixedFilterFields(tenantId, branchId),
    listCustomFields(tenantId, 'invoices', branchId ?? null),
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
