import type { WriteFormField, WriteManifest } from '../registry/types';
import type { PrefillValue, StoredRef, StoredRefValue, WorkflowModule, WriteRuleContext, WriteRuleResult } from './workflow-types';
import type { StaffConflict } from './staff-availability';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { logger } from '../../../utils/logger';
import { utcToWallTime } from '../grammar/wall-time';
import { findStaffConflicts } from './staff-availability';

/* The work order's guided form (Increment 6, B-WO; spec B13): its WriteCap
 * (the fields a chat form may write, L5), its read-only rules and the
 * "Continue in full form" prefill (L27).
 *
 * The form has the screen's own fields except service lines, the quotation
 * and contract links and the visit number (L5, L13): those are privileged
 * here and the full form covers them. staffId is never a field either; the
 * service derives it from staffIds (normalizeStaffAssignment).
 *
 * The rules only read. A site within its customer and staff within their
 * team are checked by the references (references.ts), so the rules add
 * nothing for them. They add:
 * - staff availability (L5, L17): a staff member newly put on the job, or
 *   kept on it at a new time, is checked with the read-only port of the
 *   screen's check (staff-availability.ts). Busy and newly added while the
 *   hard block is on gives a field error; otherwise a warning. Times are
 *   the tenant's and the clashing work order is never named;
 * - visibility (L15): a scoped caller is warned when the work order's staff
 *   would put it out of their sight, with "Assign to me" on a create when
 *   they have a staff profile;
 * - the Field Service default duration a create gets, and what a status
 *   change or a delete does to a linked contract visit. */

const OPS = ['create', 'update'] as const;

const FIELDS: readonly WriteFormField[] = [
  {
    key: 'customerId', label: 'Customer', kind: 'ref', ops: OPS, required: true, group: 'Details',
    ref: { module: 'customer', store: 'business', targetField: 'customerId' }, plannerFillable: false,
  },
  { key: 'title', label: 'Title', kind: 'text', ops: OPS, required: true, group: 'Details', maxLength: 300, plannerFillable: true },
  {
    key: 'siteId', label: 'Site', kind: 'ref', ops: OPS, required: false, group: 'Details',
    ref: { module: 'site', store: 'business', targetField: 'siteId', within: { field: 'customerId', childPath: 'customerId' }, clearedBy: 'customerId' },
    plannerFillable: false,
  },
  // Prefilled from the site's or the customer's address, for PII viewers only (prefill.addressPrefill; D29, L29).
  { key: 'address', label: 'Address', kind: 'longtext', ops: OPS, required: false, group: 'Details', maxLength: 2000, refuseMasked: true, plannerFillable: false },
  {
    key: 'teamId', label: 'Team', kind: 'ref', ops: OPS, required: false, group: 'People',
    ref: { module: 'team', store: 'business', targetField: 'teamId' }, plannerFillable: false,
  },
  {
    key: 'staffIds', label: 'Staff', kind: 'ref_many', ops: OPS, required: false, group: 'People',
    ref: { module: 'staff', store: 'business', targetField: 'staffId', within: { field: 'teamId', childPath: 'teamId' }, clearedBy: 'teamId', maxItems: 10 },
    quickPicks: ['assign_to_me'], plannerFillable: false,
  },
  { key: 'scheduledDate', label: 'Scheduled date and time', kind: 'datetime', ops: OPS, required: false, group: 'Schedule', future: true, plannerFillable: true },
  {
    key: 'priority', label: 'Priority', kind: 'enum', ops: OPS, required: false, group: 'Schedule',
    options: { from: 'schema' }, default: { kind: 'value', value: 'medium' }, plannerFillable: true,
  },
  {
    key: 'status', label: 'Status', kind: 'stage', ops: OPS, required: false, group: 'Schedule',
    options: { from: 'pipeline', pipeline: 'workorder' }, default: { kind: 'stage', preferred: 'draft' }, plannerFillable: true,
  },
  { key: 'discount', label: 'Discount %', kind: 'percent', ops: OPS, required: false, group: 'Money', default: { kind: 'fs_discount' }, plannerFillable: true },
  { key: 'gstPercentage', label: 'GST %', kind: 'percent', ops: OPS, required: false, group: 'Money', default: { kind: 'fs_gst' }, plannerFillable: true },
  { key: 'notes', label: 'Notes', kind: 'longtext', ops: OPS, required: false, group: 'Notes', plannerFillable: true },
];

/** Never written from the chat form: links and lines set on the page or by a
 * "from" record action, numbers and states the system keeps, and the
 * branch, which comes from the identity. */
const PRIVILEGED: readonly string[] = [
  'quotationId', 'contractId', 'contractVisitNumber', 'services', 'parts', 'partsAmount', 'checklists', 'durationHours',
  'termsAndConditions', 'completedDate', 'skills', 'photos', 'signatureUrl', 'staffId', 'branchId', 'workOrderId', 'numId',
  'workflowState', 'portalToken', 'isLocked',
];

const TIMELINE_LINE = 'The record timeline and search are updated, as when you save on the screen.';

const MANIFEST: WriteManifest = {
  will: {
    create: ['A work order number is assigned when it is saved.', TIMELINE_LINE],
    update: [TIMELINE_LINE, 'If auto-lock is set up, a work order moved to its completed stage is locked.'],
    delete: ['The timeline records the delete and an audit entry is written.', 'It is removed from search.'],
  },
};

/** The screen's own field keys "Continue in full form" may prefill (the screen sends every prefill key to its API). */
const FULL_FORM_KEYS: readonly string[] = [
  'branchId', 'customerId', 'siteId', 'teamId', 'staffIds', 'title', 'scheduledDate', 'priority', 'status', 'discount',
  'gstPercentage', 'notes', 'address',
];

const WO_HIDDEN_AFTER_CREATE = "You won't see this after creating it unless it's assigned to you.";
const REASSIGN_MAY_HIDE = 'You may not see this work order after this change.';
/** A form field's error holds at most this many characters (FormField errors). */
const FIELD_ERROR_MAX = 300;

function refsOf(value: StoredRefValue | undefined): StoredRef[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Staff keys as written (staffIds) or stored: an array, or one key; each once. */
function staffKeysOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(list.map((key) => String(key ?? '').trim()).filter(Boolean))];
}

/** A written ISO string or a stored Date, as an instant; null when empty or unreadable. */
function instantOf(value: unknown): Date | null {
  const at = value instanceof Date ? value : typeof value === 'string' && value.trim() ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** The contract visit this work order was made for, when it has one. */
function linkedVisit(record: Readonly<Record<string, unknown>> | null): { visit: string; contractId: string } | null {
  if (!record?.contractId || !record.contractVisitNumber) return null;
  return { visit: String(record.contractVisitNumber), contractId: String(record.contractId) };
}

function staffBusyText(name: string, conflict: StaffConflict, timeZone: string): string {
  return conflict.allDay || !conflict.availableAfter
    ? `${name} is busy all day.`
    : `${name} is busy then. Available after ${utcToWallTime(conflict.availableAfter, timeZone).time}.`;
}

/** Whole messages, while they fit one field error. */
function fieldErrorOf(messages: readonly string[]): string {
  let text = messages[0].slice(0, FIELD_ERROR_MAX);
  for (const message of messages.slice(1)) {
    if (text.length + 1 + message.length > FIELD_ERROR_MAX) break;
    text += ` ${message}`;
  }
  return text;
}

/** Staff availability (L5, L17). On a create every chosen staff member is
 * checked; on an update the ones newly added, and all of them when the time
 * moves. Staff already on the job only ever warn: the screen keeps them
 * selectable so an edit never traps a record. */
async function checkAvailability(input: WriteRuleContext, out: WriteRuleResult): Promise<void> {
  const { op, values, record, refs, ctx } = input;
  const storedAt = op === 'update' ? instantOf(record?.scheduledDate) : null;
  const at = 'scheduledDate' in values ? instantOf(values.scheduledDate) : storedAt;
  if (!at) return;
  const assigned = new Set(op === 'update' ? staffKeysOf(record?.staffIds) : []);
  const staff = 'staffIds' in values ? staffKeysOf(values.staffIds) : [...assigned];
  const moved = op === 'create' || at.getTime() !== storedAt?.getTime();
  // Only staff the caller can see: an unchanged one hidden from them keeps the id ''.
  const names = new Map(refsOf(refs.staffIds).filter((ref) => ref.id).map((ref): [string, string] => [ref.key, ref.label]));
  const asked = staff.filter((key) => names.has(key) && (moved || !assigned.has(key)));
  if (!asked.length) return;

  let conflicts: Map<string, StaffConflict>;
  try {
    conflicts = await findStaffConflicts({
      tenantId: input.identity.tenantId, timezone: ctx.timezone, staffIds: asked, at,
      excludeId: record?._id ? String(record._id) : undefined, now: ctx.now,
    });
  } catch (err) {
    // Advisory, as on the screen: a failed read neither blocks nor warns.
    logger.warn('CRM assist: staff availability could not be read', { module: 'workorder', error: (err as Error)?.message });
    return;
  }
  const busy: string[] = [];
  for (const key of asked) {
    const conflict = conflicts.get(key);
    if (!conflict?.busy) continue;
    const name = names.get(key) ?? key;
    if (ctx.staffHardBlock && !assigned.has(key)) busy.push(staffBusyText(name, conflict, ctx.timezone));
    else out.warnings.push(`${name} may be busy then.`);
  }
  if (busy.length) out.fieldErrors.staffIds = fieldErrorOf(busy);
}

/** Visibility (L15). A scoped caller sees a work order only through its staff
 * (staffIds within their scope's staff and user ids); who created it doesn't
 * count. Scope 'all' (an admin, or a tenant that doesn't scope work orders)
 * sees every one. */
function checkVisibility({ op, values, ctx }: WriteRuleContext, out: WriteRuleResult): void {
  if (ctx.scope.kind === 'all') return;
  if (op === 'update' && !('staffIds' in values)) return;
  const seen = new Set([...ctx.scope.staffIds, ...ctx.scope.createdByUserIds]);
  if (staffKeysOf(values.staffIds).some((key) => seen.has(key))) return;
  if (op === 'update') {
    out.warnings.push(REASSIGN_MAY_HIDE);
    return;
  }
  out.warnings.push(WO_HIDDEN_AFTER_CREATE);
  if (ctx.ownStaff?.id) {
    out.quickPicks = { staffIds: [{ label: 'Assign to me', value: [{ ref: ctx.ownStaff.id, label: ctx.ownStaff.label }] }] };
  }
}

/** A status change on a work order made for a contract visit moves the visit
 * too (updateWorkorder): the stage tagged 'completed' completes it, the one
 * tagged 'cancelled' sends it back to planned. The keys are found as the
 * service finds them (getOutcomeStageKey), read with peekStages. */
async function addContractVisitLines(input: WriteRuleContext, out: WriteRuleResult): Promise<void> {
  const linked = linkedVisit(input.record);
  const status = input.values.status;
  if (!linked || typeof status !== 'string' || !status || status === input.record?.status) return;
  const stages = await peekStages(input.identity.tenantId, 'workorder');
  // peekStages reads lean: a stage saved before isActive existed counts as active, as on the hydrated read.
  const taggedKey = (outcome: string) => stages.find((s) => s.outcome === outcome && s.isActive !== false)?.key ?? outcome;
  const visit = `Visit ${linked.visit} of contract ${linked.contractId}`;
  if (status === taggedKey('completed')) {
    out.sideEffects.push({ kind: 'linked', text: `${visit} will be marked completed.` });
  } else if (status === taggedKey('cancelled')) {
    out.sideEffects.push(
      { kind: 'linked', text: `${visit} goes back to planned and loses its link to this work order.` },
      { kind: 'later', text: 'If that contract creates work orders automatically, a new work order may be created for that visit.' },
    );
  }
}

async function check(input: WriteRuleContext): Promise<WriteRuleResult> {
  const out: WriteRuleResult = { fieldErrors: {}, formErrors: [], warnings: [], sideEffects: [] };
  if (input.op === 'delete') {
    // deleteWorkorder leaves the visit as it is, and the contract only makes work orders for planned visits.
    const linked = linkedVisit(input.record);
    if (linked) {
      out.warnings.push(`This work order came from visit ${linked.visit} of contract ${linked.contractId}. The visit stays scheduled `
        + 'and keeps pointing to this work order; no new work order is created for it automatically.');
    }
    return out;
  }
  checkVisibility(input, out);
  await checkAvailability(input, out);
  const hours = input.ctx.defaultDurationHours;
  if (input.op === 'create' && input.values.durationHours == null && hours && hours > 0) {
    // createWorkorder sets it from the branch's settings (else the organization's), as FormContext reads them.
    out.sideEffects.push({ kind: 'will', text: `Duration is set to the Field Service default of ${hours} ${hours === 1 ? 'hour' : 'hours'}.` });
  }
  if (input.op === 'update') await addContractVisitLines(input, out);
  return out;
}

type FullFormInput = Parameters<NonNullable<WorkflowModule['fullFormPrefill']>>[0];

/** "Continue in full form" (L27): the screen's own keys only, with the
 * business ids its lookups hold (never a record's _id), the operation's
 * company (the screen skips its company defaults when a prefill arrives),
 * the checked values, and the address only for a caller who may view the
 * address it came from (D29). */
function fullFormPrefill({ refs, values, branchId, ctx }: FullFormInput): Record<string, PrefillValue> {
  const prefill: Record<string, PrefillValue> = {};
  if (branchId) prefill.branchId = branchId;
  for (const key of ['customerId', 'siteId', 'teamId']) {
    const ref = refsOf(refs[key])[0];
    if (ref?.key) prefill[key] = ref.key;
  }
  const staff = refsOf(refs.staffIds).map((ref) => ref.key).filter(Boolean);
  if (staff.length) prefill.staffIds = staff;
  for (const key of ['title', 'priority', 'status', 'notes']) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) prefill[key] = value;
  }
  const at = instantOf(values.scheduledDate);
  if (at) prefill.scheduledDate = at.toISOString();
  for (const key of ['discount', 'gstPercentage']) {
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value)) prefill[key] = value;
  }
  const addressVisible = refs.siteId ? ctx.sitePiiVisible : ctx.customerPiiVisible;
  if (addressVisible && typeof values.address === 'string' && values.address.trim()) prefill.address = values.address;
  return prefill;
}

export const WORKORDER_WORKFLOW: WorkflowModule = {
  cap: {
    module: 'workorder',
    ops: ['create', 'update', 'delete'],
    versionToken: 'compare_and_set',
    fields: FIELDS,
    customFields: true,
    privilegedFields: PRIVILEGED,
    manifest: MANIFEST,
    primaryText: 'title',
    forRef: 'customerId',
    fullForm: { list: '/native-crm/workorders', keys: FULL_FORM_KEYS },
  },
  rules: { check },
  fullFormPrefill,
};
