import type { WriteFormField, WriteLineSpec, WriteManifest } from '../registry/types';
import type { WorkflowModule, WriteRuleContext, WriteRuleResult } from './workflow-types';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { normalizeSnapshotValue } from '../../internal/crm-gateway.helpers';

/* The quotation's guided form (Increment 7, spec B7, M21): its WriteCap (the
 * New Quotation drawer's own fields, with lines priced from the service
 * catalog), its read-only rules and its card lines. A create writes through
 * createQuotation, so the service's own totals, number, search index and
 * stage check run as on the screen. An update changes the customer, title,
 * address, validity, status, notes and custom fields only, so the service
 * never recomputes a total from chat (M14). A delete is refused with a
 * notice and a link to the Quotations page (D20, M22).
 *
 * The lines are not fields: the form's lines (operations/document-lines.ts)
 * write services and parts before the screen's Zod, and the totals the form
 * and the card show are the service's own (NC/shared/document-totals.ts,
 * unrounded as createQuotation stores them). Discount and GST take the Field
 * Service defaults, as the drawer does, on create only.
 *
 * The rules only read (peekStages, never the stage functions that can write
 * before Confirm). They add:
 * - the approved stage: a create saved as approved is not locked
 *   (createQuotation never locks); an update moving it there is locked after
 *   Confirm when auto-lock is set up (quotation.hooks.ts);
 * - "Sent" sends nothing; a validity date already past; a stored validity
 *   date can't be emptied (the screen can't empty it either);
 * - an update of a converted quotation, and a customer change that keeps the
 *   saved address. */

/* ── Texts (spec B12) ── */
const QUOTATION_DELETE_REFUSED = "Quotations can't be deleted from the assistant. Open the quotation to delete it on its page.";
const QUOTATION_NUMBER_LINE = 'A quotation number is assigned when it is saved.';
const TIMELINE_LINE = 'The record timeline and search are updated, as when you save on the screen.';
const QUOTATION_TOTAL_LINE = 'The total is worked out from the lines, discount and GST exactly as the quotation page saves it.';
const QUOTATION_PRICES_BLOCKED = 'Prices come from your service catalog. To use another price, create the quotation on its page.';
const QUOTATION_MONEY_BLOCKED = 'Lines, discount and GST of an existing quotation are changed on the quotation page.';
const QUOTATION_LOCK_LINE = 'If auto-lock is set up, a quotation moved to its approved stage is locked.';
const APPROVED_ON_CREATE = 'It is saved as approved but not locked. Auto-lock applies when a saved quotation is moved to approved.';
const SENT_SENDS_NOTHING = "Marking it Sent doesn't send it. Use Share on the quotation page to email it or copy its link.";
const VALIDITY_PASSED = 'This date has already passed.';
const CONVERTED_QUOTATION = "This quotation was already converted. Documents made from it won't change.";
const CUSTOMER_CHANGED_ADDRESS = 'The address is still the one saved on this quotation. Check it for the new customer.';
const DATE_CANT_EMPTY = "This date can't be emptied here.";

const OPS = ['create', 'update'] as const;
const CREATE_ONLY = ['create'] as const;

const FIELDS: readonly WriteFormField[] = [
  {
    key: 'customerId', label: 'Customer', kind: 'ref', ops: OPS, required: true, group: 'Details',
    ref: { module: 'customer', store: 'business', targetField: 'customerId' }, plannerFillable: false,
  },
  { key: 'title', label: 'Title', kind: 'text', ops: OPS, required: true, group: 'Details', maxLength: 300, plannerFillable: true },
  // Prefilled from the customer's address for customer-PII viewers only, else empty with the hint (prefill.addressPrefill; D29, L29).
  { key: 'address', label: 'Address', kind: 'longtext', ops: OPS, required: false, group: 'Details', maxLength: 2000, refuseMasked: true, plannerFillable: false },
  // Create only (M14): an update that sends either makes updateQuotation recompute the totals from the stored lines.
  { key: 'discount', label: 'Discount %', kind: 'percent', ops: CREATE_ONLY, required: false, group: 'Money', default: { kind: 'fs_discount' }, plannerFillable: false },
  { key: 'gstPercentage', label: 'GST %', kind: 'percent', ops: CREATE_ONLY, required: false, group: 'Money', default: { kind: 'fs_gst' }, plannerFillable: false },
  { key: 'validUntil', label: 'Valid until', kind: 'date', ops: OPS, required: false, group: 'Details', future: true, plannerFillable: true },
  {
    key: 'status', label: 'Status', kind: 'stage', ops: OPS, required: false, group: 'Details',
    options: { from: 'pipeline', pipeline: 'quotation' }, default: { kind: 'stage', preferred: 'draft' }, plannerFillable: true,
  },
  { key: 'notes', label: 'Notes', kind: 'longtext', ops: OPS, required: false, group: 'Notes', plannerFillable: true },
];

/** Never written from the chat form: the links a conversion sets, the totals the service works out, the terms,
 * the document-chain state, the portal token, the lock, the numbers, and the branch and creator, which come from
 * the identity. services and parts are not listed: they are written only through the form's lines. */
const PRIVILEGED: readonly string[] = [
  'contractId', 'siteId', 'staffId', 'teamId', 'partsAmount', 'servicesAmount', 'servicesAmountWithTax', 'termsAndConditions',
  'workflowState', 'portalToken', 'isLocked', 'lockedAt', 'lockedBy', 'lockReason', 'quotationId', 'numId', 'clientId', 'branchId',
  'createdBy',
];

const MANIFEST: WriteManifest = {
  will: { create: [QUOTATION_NUMBER_LINE, TIMELINE_LINE, QUOTATION_TOTAL_LINE], update: [TIMELINE_LINE] },
  blocked: { create: [QUOTATION_PRICES_BLOCKED], update: [QUOTATION_MONEY_BLOCKED] },
};

/** Catalog services only, as the drawer adds them (M8); a create needs one (M11); at most 50 rows (M10); the
 * quotation's own totals (createQuotation's, unrounded). */
const LINES: WriteLineSpec = { add: ['service'], required: true, max: 50, totals: 'quotation' };

/* ── Rules (read-only) ── */
const textOf = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Whether this update changes `key`, compared as the review compares it (operations/diff.ts): a day and its
 * stored instant alike, every empty value alike. A value that doesn't change is never sent. */
function changes(input: WriteRuleContext, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input.values, key)
    && normalizeSnapshotValue(input.values[key]) !== normalizeSnapshotValue(input.record?.[key]);
}

/** The key the hooks lock on after Confirm (lockQuotationIfApproved: getOutcomeStageKey 'approved', else
 * 'approved'), read with peekStages: getOutcomeStageKey can create the pipeline before Confirm. */
async function approvedKeyOf(tenantId: string): Promise<string> {
  const stages = await peekStages(tenantId, 'quotation');
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  return stages.find((s) => s.outcome === 'approved' && s.isActive !== false)?.key ?? 'approved';
}

async function check(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out: WriteRuleResult = { fieldErrors: {}, formErrors: [], warnings: [], sideEffects: [] };
  const { op, values, record, ctx } = input;
  // A delete never gets here: it is refused before any form (cap.refused).
  if (op === 'delete') return out;

  // The stage set by a create, or moved to by an update (an unchanged one is never sent, so never locks).
  const status = textOf(values.status);
  if (status && (op === 'create' || changes(input, 'status'))) {
    if (status === await approvedKeyOf(input.identity.tenantId)) {
      if (op === 'create') out.warnings.push(APPROVED_ON_CREATE);
      else out.sideEffects.push({ kind: 'will', text: QUOTATION_LOCK_LINE });
    }
    if (status === 'sent') out.warnings.push(SENT_SENDS_NOTHING);
  }

  // A day key ('YYYY-MM-DD'), compared with the tenant's today. The drawer never sends an empty date, so a stored
  // one can't be emptied on the screen either (M21).
  const validUntil = textOf(values.validUntil);
  if (op === 'create' ? validUntil !== '' : changes(input, 'validUntil')) {
    if (!validUntil) out.fieldErrors.validUntil = DATE_CANT_EMPTY;
    else if (validUntil < ctx.todayKey) out.warnings.push(VALIDITY_PASSED);
  }

  if (op === 'update') {
    // workflowState 'complete': a work order, invoice or contract was already made from it (shown as Converted).
    if (record?.workflowState === 'complete') out.warnings.push(CONVERTED_QUOTATION);
    // The address prefill never overwrites a stored address (applyAddressPrefill).
    if (changes(input, 'customerId') && !changes(input, 'address')) out.warnings.push(CUSTOMER_CHANGED_ADDRESS);
  }
  return out;
}

export const QUOTATION_WORKFLOW: WorkflowModule = {
  cap: {
    module: 'quotation',
    ops: ['create', 'update'],
    refused: { delete: QUOTATION_DELETE_REFUSED },
    versionToken: 'compare_and_set',
    fields: FIELDS,
    customFields: true,
    privilegedFields: PRIVILEGED,
    manifest: MANIFEST,
    primaryText: 'title',
    forRef: 'customerId',
    lines: LINES,
  },
  rules: { check },
};
