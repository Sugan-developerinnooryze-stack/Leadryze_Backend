import { BuiltInPipelineModule } from '../pipeline-config/pipeline-config.model';

export interface ITargetFieldOption {
  value: string;
  label: string;
}

export interface ITargetFieldDef {
  key:   string;
  label: string;
  type:  'text' | 'number' | 'date' | 'boolean' | 'select';
  /** Static choices for a 'select' field — omitted for stage/status fields
   * (see isStageField below), whose choices are per-tenant and filled in
   * dynamically instead. */
  options?: ITargetFieldOption[];
  /** True for the one field per module that IS this module's pipeline stage
   * — getFieldCatalog() fills its `options` at read time from the tenant's
   * own currently-configured stages (native-crm/pipeline-config), since
   * those can't be hand-authored here the way a fixed enum can. */
  isStageField?: boolean;
  /** True for the one field per module that is the module's real
   * owner/assignee FK (a NativeStaff.staffId reference) — drives the
   * Assign Record action's staff-picker. Distinct from a cosmetic
   * free-text "owner" field where one happens to exist (e.g. Lead's own
   * `leadOwner` text field, left un-flagged, untouched) — this must be the
   * real, queryable assignment field the rest of the app's own
   * scope/recipient resolution already treats as canonical (see
   * resolveAutomationRecipient's 'assigned_user' strategy). Absent for a
   * module with no assignee concept at all (Ticket/Quotation/Invoice) —
   * Assign Record has nothing to offer there, computed dynamically from
   * whether this flag appears anywhere in the module's catalog, never
   * hardcoded per-module in the UI. */
  isAssigneeField?: boolean;
}

/**
 * Hand-authored per built-in module — same convention as the OUTCOME_OPTIONS
 * map in PipelineSettingsPage.tsx (a per-built-in-module lookup, not a
 * generic reflection-based catalog), since built-in modules have no dynamic
 * field metadata the way Custom Modules do (ICustomModuleField[]).
 *
 * Deliberately excludes: _id/tenantId/branchId/clientId/createdAt/updatedAt,
 * lock fields, customFields (has its own picker elsewhere), nested arrays
 * (services[]/parts[]/visits[]/etc. — not flat mapping targets), and each
 * module's own server-generated identifier (numId, leadId, quotationId,
 * workOrderId, contractId, invoiceId, portalToken, workflowState) — those are
 * assigned by each model's own pre-save hook and aren't meaningful write
 * targets. Cross-references to OTHER modules (e.g. Invoice.workOrderId,
 * WorkOrder.contractId) ARE included — those are exactly what a
 * backReferenceField mapping is for.
 */
export const BUILT_IN_TARGET_FIELDS: Record<BuiltInPipelineModule, ITargetFieldDef[]> = {
  lead: [
    { key: 'firstName',      label: 'First Name',       type: 'text' },
    { key: 'lastName',       label: 'Last Name',        type: 'text' },
    { key: 'company',        label: 'Company',          type: 'text' },
    { key: 'designation',    label: 'Designation',      type: 'text' },
    { key: 'email',          label: 'Email',            type: 'text' },
    { key: 'phone',          label: 'Phone',            type: 'text' },
    { key: 'mobile',         label: 'Mobile',           type: 'text' },
    { key: 'source',         label: 'Source',           type: 'select', options: [
      { value: 'website', label: 'Website' }, { value: 'landing_page', label: 'Landing Page' },
      { value: 'chatbot', label: 'Chatbot' }, { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'facebook', label: 'Facebook' }, { value: 'google', label: 'Google' },
      { value: 'manual', label: 'Manual' }, { value: 'csv', label: 'CSV Import' },
      { value: 'api', label: 'API' }, { value: 'referral', label: 'Referral' }, { value: 'other', label: 'Other' },
    ] },
    { key: 'status',         label: 'Status',           type: 'select', isStageField: true },
    { key: 'rating',         label: 'Rating',           type: 'select', options: [
      { value: 'hot', label: 'Hot' }, { value: 'warm', label: 'Warm' }, { value: 'cold', label: 'Cold' },
    ] },
    { key: 'city',           label: 'City',             type: 'text' },
    { key: 'state',          label: 'State',            type: 'text' },
    { key: 'country',        label: 'Country',          type: 'text' },
    { key: 'leadOwner',      label: 'Owner',            type: 'text' },
    { key: 'leadOwnerStaffId', label: 'Owner (Staff)',  type: 'text', isAssigneeField: true },
    { key: 'expectedRevenue',label: 'Expected Revenue', type: 'number' },
    { key: 'notes',          label: 'Notes',            type: 'text' },
  ],
  deal: [
    { key: 'title',       label: 'Deal Title', type: 'text' },
    { key: 'amount',       label: 'Amount',     type: 'number' },
    { key: 'currency',     label: 'Currency',   type: 'text' },
    { key: 'stage',        label: 'Stage',      type: 'select', isStageField: true },
    { key: 'closeDate',    label: 'Close Date', type: 'date' },
    { key: 'contactName',  label: 'Contact',    type: 'text' },
    { key: 'companyName',  label: 'Company',    type: 'text' },
    { key: 'assignedStaffId', label: 'Assigned Staff', type: 'text', isAssigneeField: true },
    { key: 'notes',        label: 'Notes',      type: 'text' },
  ],
  task: [
    { key: 'title',        label: 'Title',        type: 'text' },
    { key: 'dueDate',      label: 'Due Date',     type: 'date' },
    { key: 'priority',     label: 'Priority',     type: 'select', options: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] },
    { key: 'taskStatus',   label: 'Status',       type: 'select', isStageField: true },
    { key: 'assignedTo',   label: 'Assigned To',  type: 'text', isAssigneeField: true },
    { key: 'notes',        label: 'Notes',        type: 'text' },
  ],
  ticket: [
    { key: 'subject',      label: 'Subject',      type: 'text' },
    { key: 'priority',     label: 'Priority',     type: 'select', options: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
    ] },
    { key: 'ticketStatus', label: 'Status',       type: 'select', isStageField: true },
    { key: 'description',  label: 'Description',  type: 'text' },
    { key: 'contactName',  label: 'Contact Name', type: 'text' },
  ],
  quotation: [
    { key: 'customerId',            label: 'Customer',                 type: 'text' },
    { key: 'title',                 label: 'Title',                    type: 'text' },
    { key: 'address',               label: 'Address',                  type: 'text' },
    { key: 'partsAmount',           label: 'Parts Amount',             type: 'number' },
    { key: 'discount',              label: 'Discount',                 type: 'number' },
    { key: 'gstPercentage',         label: 'GST %',                    type: 'number' },
    { key: 'servicesAmount',        label: 'Services Amount',          type: 'number' },
    { key: 'status',                label: 'Status',                  type: 'select', isStageField: true },
    { key: 'notes',                 label: 'Notes',                    type: 'text' },
    { key: 'termsAndConditions',    label: 'Terms and Conditions',     type: 'text' },
    { key: 'validUntil',            label: 'Valid Until',              type: 'date' },
  ],
  workorder: [
    { key: 'customerId',         label: 'Customer',      type: 'text' },
    { key: 'quotationId',        label: 'Quotation',     type: 'text' },
    { key: 'contractId',         label: 'Contract',      type: 'text' },
    { key: 'siteId',             label: 'Site',          type: 'text' },
    { key: 'teamId',             label: 'Team',          type: 'text' },
    { key: 'staffId',            label: 'Staff',         type: 'text', isAssigneeField: true },
    { key: 'title',              label: 'Title',         type: 'text' },
    { key: 'scheduledDate',      label: 'Scheduled Date',type: 'date' },
    { key: 'durationHours',      label: 'Duration (hrs)',type: 'number' },
    { key: 'discount',           label: 'Discount',      type: 'number' },
    { key: 'gstPercentage',      label: 'GST %',         type: 'number' },
    { key: 'priority',           label: 'Priority',      type: 'select', options: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] },
    { key: 'status',             label: 'Status',        type: 'select', isStageField: true },
    { key: 'notes',              label: 'Notes',         type: 'text' },
    { key: 'termsAndConditions', label: 'Terms and Conditions', type: 'text' },
  ],
  contract: [
    { key: 'customerId',         label: 'Customer',      type: 'text' },
    { key: 'quotationId',        label: 'Quotation',     type: 'text' },
    { key: 'title',              label: 'Title',         type: 'text' },
    { key: 'siteId',             label: 'Site',          type: 'text' },
    { key: 'staffId',            label: 'Staff',         type: 'text', isAssigneeField: true },
    { key: 'teamId',             label: 'Team',          type: 'text' },
    { key: 'startDate',          label: 'Start Date',    type: 'date' },
    { key: 'endDate',            label: 'End Date',      type: 'date' },
    { key: 'contractType',       label: 'Contract Type', type: 'select', options: [
      { value: 'amc', label: 'AMC' }, { value: 'maintenance', label: 'Maintenance' },
      { value: 'rental', label: 'Rental' }, { value: 'warranty', label: 'Warranty' },
      { value: 'preventive', label: 'Preventive' }, { value: 'corrective', label: 'Corrective' },
      { value: 'installation', label: 'Installation' }, { value: 'inspection', label: 'Inspection' },
      { value: 'custom', label: 'Custom' },
    ] },
    { key: 'priority',           label: 'Priority',      type: 'select', options: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
    ] },
    { key: 'renewalType',        label: 'Renewal Type',  type: 'select', options: [
      { value: 'manual', label: 'Manual' }, { value: 'automatic', label: 'Automatic' },
    ] },
    { key: 'serviceFrequency',   label: 'Service Frequency', type: 'text' },
    { key: 'discount',           label: 'Discount',      type: 'number' },
    { key: 'gstPercentage',      label: 'GST %',         type: 'number' },
    { key: 'servicesAmount',     label: 'Services Amount', type: 'number' },
    { key: 'status',             label: 'Status',        type: 'select', isStageField: true },
    { key: 'notes',              label: 'Notes',         type: 'text' },
    { key: 'termsAndConditions', label: 'Terms and Conditions', type: 'text' },
  ],
  invoice: [
    { key: 'customerId',         label: 'Customer',      type: 'text' },
    { key: 'workOrderId',        label: 'Work Order',    type: 'text' },
    { key: 'quotationId',        label: 'Quotation',     type: 'text' },
    { key: 'contractId',         label: 'Contract',      type: 'text' },
    { key: 'address',            label: 'Address',       type: 'text' },
    { key: 'partsAmount',        label: 'Parts Amount',  type: 'number' },
    { key: 'discount',           label: 'Discount',      type: 'number' },
    { key: 'gstPercentage',      label: 'GST %',         type: 'number' },
    { key: 'servicesAmount',     label: 'Services Amount', type: 'number' },
    { key: 'dueDate',            label: 'Due Date',      type: 'date' },
    { key: 'status',             label: 'Status',        type: 'select', isStageField: true },
    { key: 'notes',              label: 'Notes',         type: 'text' },
    { key: 'termsAndConditions', label: 'Terms and Conditions', type: 'text' },
  ],
};
