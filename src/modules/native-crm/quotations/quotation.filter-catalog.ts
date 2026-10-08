import { listCustomFields } from '../custom-fields/custom-field.service';
import { getCustomerOptions, getStatusOptions } from '../shared/lookup-options';
import { FilterFieldDef, customFieldFilterType } from '../shared/dynamic-filter';

const WORKFLOW_STATE_OPTIONS = [
  { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }, { value: 'complete', label: 'Complete' },
];

/** Mirrors the exact set of real, populated fields FSTable's own "Edit
 * Columns" shows for this page (explicit columns + auto-derived raw record
 * keys — see FSTable.tsx's deriveAllColumns/SKIP_KEYS) — not a separately
 * hand-picked list, so a field visible in Edit Columns is filterable here
 * too, and one that isn't (Site/Team/Staff — Quotations' own create form
 * never collects them, confirmed empty on every real record) isn't offered
 * as a dead end. The two deliberate exceptions are Created Date and
 * Company: both are real fields, but already have a dedicated, better
 * control on this page (the Date button's presets, the Company tabs) doing
 * the identical job — included here too would just be a worse duplicate. */
async function getFixedFilterFields(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [customerOptions, statusOptions] = await Promise.all([
    getCustomerOptions(tenantId, branchId),
    getStatusOptions(tenantId, 'quotation'),
  ]);

  return [
    { key: 'quotationId',           label: 'ID',               type: 'text',    path: 'quotationId',           source: 'fixed' },
    { key: 'title',                 label: 'Title',            type: 'text',    path: 'title',                 source: 'fixed' },
    { key: 'customerId',            label: 'Customer',         type: 'select',  path: 'customerId',            options: customerOptions, source: 'fixed' },
    { key: 'status',                label: 'Status',           type: 'select',  path: 'status',                options: statusOptions, source: 'fixed' },
    { key: 'workflowState',         label: 'Workflow State',   type: 'select',  path: 'workflowState',         options: WORKFLOW_STATE_OPTIONS, source: 'fixed' },
    { key: 'address',               label: 'Address',          type: 'text',    path: 'address',               source: 'fixed' },
    { key: 'notes',                 label: 'Notes',            type: 'text',    path: 'notes',                 source: 'fixed' },
    { key: 'clientId',              label: 'Client ID',        type: 'text',    path: 'clientId',              source: 'fixed' },
    { key: 'validUntil',            label: 'Valid Until',      type: 'date',    path: 'validUntil',            source: 'fixed' },
    { key: 'discount',              label: 'Discount',         type: 'number',  path: 'discount',              source: 'fixed' },
    { key: 'gstPercentage',         label: 'GST %',            type: 'number',  path: 'gstPercentage',         source: 'fixed' },
    { key: 'partsAmount',           label: 'Parts Amount',     type: 'number',  path: 'partsAmount',           source: 'fixed' },
    { key: 'servicesAmount',        label: 'Services Amount',  type: 'number',  path: 'servicesAmount',        source: 'fixed' },
    { key: 'servicesAmountWithTax', label: 'Total',            type: 'number',  path: 'servicesAmountWithTax', source: 'fixed' },
    { key: 'isLocked',              label: 'Locked',           type: 'boolean', path: 'isLocked',              source: 'fixed' },
  ];
}

/** Fixed catalog + this tenant's currently-active custom fields for the
 * "quotations" module — a custom field added later shows up here
 * automatically, no code change needed. */
export async function getQuotationFilterCatalog(tenantId: string, branchId?: string | null): Promise<FilterFieldDef[]> {
  const [fixed, customFields] = await Promise.all([
    getFixedFilterFields(tenantId, branchId),
    listCustomFields(tenantId, 'quotations', branchId ?? null),
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
