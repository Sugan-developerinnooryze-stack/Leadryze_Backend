import type { ZodTypeAny } from 'zod';
import type { CrmWriteModuleDef } from '../../internal/crm-write.module-map';
import type { ModuleCap } from '../registry/types';
import {
  getWritableFieldDefs, findDisallowedWriteKeys, findNonScalarWriteValues, findOutOfRangePercentValues,
} from '../../internal/crm-read.service';
import { peekStages } from '../../native-crm/pipeline-config/pipeline-config.service';
import { PII_FIELDS } from '../../../platform/pii/constants';
import { createLeadSchema, updateLeadSchema } from '../../native-crm/leads/lead.validation';
import { createWorkorderSchema, updateWorkorderSchema } from '../../native-crm/workorders/workorder.validation';
import { createInvoiceSchema, updateInvoiceSchema } from '../../native-crm/invoices/invoice.validation';
import { createQuotationSchema, updateQuotationSchema } from '../../native-crm/quotations/quotation.validation';
import { createCategorySchema, updateCategorySchema } from '../../native-crm/categories/category.validation';
import { createServiceSchema, updateServiceSchema } from '../../native-crm/services/service.validation';
import { createPartSchema, updatePartSchema } from '../../native-crm/parts/part.validation';
import { createProductSchema, updateProductSchema } from '../../native-crm/products/product.validation';
import { createAssetSchema, updateAssetSchema } from '../../native-crm/assets/asset.validation';
import { createVehicleSchema, updateVehicleSchema } from '../../native-crm/vehicles/vehicle.validation';
import { createExpenseSchema, updateExpenseSchema } from '../../native-crm/expenses/expense.validation';
import { createCompanySchema, updateCompanySchema } from '../../native-crm/companies/company.validation';
import { createTaskSchema, updateTaskSchema } from '../../native-crm/tasks/task.validation';
import { createTicketSchema, updateTicketSchema } from '../../native-crm/tickets/ticket.validation';
import { createCallSchema, updateCallSchema } from '../../native-crm/calls/call.validation';
import { createSiteSchema, updateSiteSchema } from '../../native-crm/sites/site.validation';
import { createTeamSchema, updateTeamSchema } from '../../native-crm/teams/team.validation';
import { createCustomerSchema, updateCustomerSchema } from '../../native-crm/customers/customer.validation';
import { createStaffSchema, updateStaffSchema } from '../../native-crm/staffs/staff.validation';
import { createDealSchema, updateDealSchema } from '../../native-crm/deals/deal.validation';
import { createContactSchema, updateContactSchema } from '../../native-crm/contacts/contact.validation';
import { createActivitySchema, updateActivitySchema } from '../../native-crm/activities/activity.validation';

/* The validation stack of a staged change (plan 5.4, the parts that exist
 * today). Stage and Confirm both run it, in this order:
 *   1. the write allowlist and the system / computed / privileged keys
 *      (the checks POST /crm-write runs), one value per built-in field,
 *      discount and GST from 0 to 100;
 *   2. masked PII is refused (a value the caller only saw masked);
 *   3. the screen's own Zod schema, keeping its parsed output, so unknown
 *      keys are dropped and values trimmed / coerced as on the screen;
 *   4. a pipeline status must be one of the tenant's active stages, read
 *      with peekStages (never getOrCreateStages or isValidStageKey, which
 *      can write).
 * Nothing here writes. Errors come back per field. */

const SCREEN_SCHEMAS: Readonly<Record<string, { create: ZodTypeAny; update: ZodTypeAny }>> = {
  lead: { create: createLeadSchema, update: updateLeadSchema },
  workorder: { create: createWorkorderSchema, update: updateWorkorderSchema },
  invoice: { create: createInvoiceSchema, update: updateInvoiceSchema },
  quotation: { create: createQuotationSchema, update: updateQuotationSchema },
  category: { create: createCategorySchema, update: updateCategorySchema },
  service: { create: createServiceSchema, update: updateServiceSchema },
  part: { create: createPartSchema, update: updatePartSchema },
  product: { create: createProductSchema, update: updateProductSchema },
  asset: { create: createAssetSchema, update: updateAssetSchema },
  vehicle: { create: createVehicleSchema, update: updateVehicleSchema },
  expense: { create: createExpenseSchema, update: updateExpenseSchema },
  company: { create: createCompanySchema, update: updateCompanySchema },
  task: { create: createTaskSchema, update: updateTaskSchema },
  ticket: { create: createTicketSchema, update: updateTicketSchema },
  call: { create: createCallSchema, update: updateCallSchema },
  site: { create: createSiteSchema, update: updateSiteSchema },
  team: { create: createTeamSchema, update: updateTeamSchema },
  customer: { create: createCustomerSchema, update: updateCustomerSchema },
  staff: { create: createStaffSchema, update: updateStaffSchema },
  deal: { create: createDealSchema, update: updateDealSchema },
  contact: { create: createContactSchema, update: updateContactSchema },
  activity: { create: createActivitySchema, update: updateActivitySchema },
};

export function screenSchemaFor(module: string, op: 'create' | 'update'): ZodTypeAny | undefined {
  return SCREEN_SCHEMAS[module]?.[op];
}

export const MASKED_VALUE_MESSAGE = 'This value is hidden for your role. Type the full value, or leave it out.';
const NOT_ALLOWED_MESSAGE = "This field can't be set from the assistant.";
const NON_SCALAR_MESSAGE = 'Needs a single value, not a list or an object.';
const PERCENT_MESSAGE = 'Enter a percentage from 0 to 100.';

/** The screens' own test for a masked value (RecordDrawer / the update
 * schemas): it contains "*" or a run of "X". */
export function looksMasked(value: unknown): boolean {
  return typeof value === 'string' && (value.includes('*') || /X{2,}/.test(value));
}

function piiKeysFor(logModule: string): Set<string> {
  const def = PII_FIELDS[logModule];
  return new Set(def ? [...def.level2, ...def.level3] : []);
}

function isCustomKey(key: string): boolean {
  return key === 'customFields' || key.startsWith('customFields.');
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function humanize(value: string): string {
  const spaced = value.replace(/^customFields\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

export interface ValidationInput {
  module: string;
  op: 'create' | 'update';
  tenantId: string;
  branchId: string | null;
  def: CrmWriteModuleDef;
  cap: ModuleCap;
  data: Record<string, unknown>;
}

export type ValidationResult =
  | {
      ok: true;
      /** What will be written (before an update is reduced to its changes). */
      values: Record<string, unknown>;
      /** Field keys the write allowlist accepts for this caller. */
      writable: string[];
      /** Label per field key, for the review. */
      labels: Record<string, string>;
      warnings: string[];
    }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

function fail(message: string, fieldErrors: Record<string, string>): ValidationResult {
  return { ok: false, message, fieldErrors };
}

/** Field label: the registry's, then the module's field list, then the key. */
export function fieldLabel(key: string, cap: ModuleCap | undefined, labels: Record<string, string>): string {
  const field = cap?.fields.find((f) => f.key === key || f.path === key);
  return field?.label ?? labels[key] ?? humanize(key);
}

async function checkPipelineStatus(
  input: ValidationInput, values: Record<string, unknown>, fieldErrors: Record<string, string>,
): Promise<void> {
  const { def, cap } = input;
  if (def.statusFilter.kind !== 'pipeline') return;
  const field = cap.stage && 'pipeline' in cap.stage ? cap.stage.field : (def.statusField ?? 'status');
  const raw = values[field];
  if (raw === undefined) return;
  if (typeof raw !== 'string' || !raw.trim()) { fieldErrors[field] = 'Choose a status.'; return; }
  const stages = await peekStages(input.tenantId, def.statusFilter.pipelineModule);
  // peekStages reads lean: a stage saved before isActive existed counts as active.
  const active = stages.filter((s) => s.isActive !== false);
  if (!active.length) return; // nothing to check against; the service decides
  const wanted = normalizeToken(raw);
  const match = active.find((s) => normalizeToken(s.key) === wanted)
    ?? active.find((s) => !!s.label && normalizeToken(s.label) === wanted);
  if (match) { values[field] = match.key; return; }
  fieldErrors[field] = `Unknown status. Use one of: ${active.map((s) => s.label || s.key).join(', ')}.`;
}

/** Runs the stack. `data` is what the assistant proposed. */
export async function validateWriteValues(input: ValidationInput): Promise<ValidationResult> {
  const { module, op, def, cap, data } = input;
  const writableDefs = await getWritableFieldDefs(module, input.tenantId, input.branchId);
  const writable = writableDefs.map((f) => f.key);
  const labels: Record<string, string> = {};
  for (const f of writableDefs) labels[f.key] = f.label;
  const label = (key: string) => fieldLabel(key, cap, labels);

  // 1. Allowlist, system / computed / privileged keys, one value, percentages.
  const disallowed = findDisallowedWriteKeys(data, writable);
  if (disallowed.length) {
    return fail(
      `These fields can't be set through the assistant for ${def.label}: ${disallowed.join(', ')}.`,
      Object.fromEntries(disallowed.map((k) => [k, NOT_ALLOWED_MESSAGE])),
    );
  }
  const fieldErrors: Record<string, string> = {};
  for (const key of findNonScalarWriteValues(data)) fieldErrors[key] = NON_SCALAR_MESSAGE;
  for (const key of findOutOfRangePercentValues(data)) fieldErrors[key] ??= PERCENT_MESSAGE;

  // 2. Masked PII.
  const pii = piiKeysFor(def.logModule);
  for (const [key, value] of Object.entries(data)) {
    if (pii.has(key) && looksMasked(value)) fieldErrors[key] ??= MASKED_VALUE_MESSAGE;
  }
  if (Object.keys(fieldErrors).length) {
    return fail(`Some values can't be used: ${Object.keys(fieldErrors).map(label).join(', ')}.`, fieldErrors);
  }

  // 3. The screen's own schema, on the built-in fields (custom fields keep
  // the allowlist check above, as on /crm-write).
  const builtIn: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) (isCustomKey(key) ? custom : builtIn)[key] = value;
  const schema = screenSchemaFor(module, op);
  if (!schema) return fail(`${def.label} can't be changed from the assistant.`, {});
  const parsed = schema.safeParse(builtIn);
  if (!parsed.success) {
    const flat = parsed.error.flatten() as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    for (const [key, messages] of Object.entries(flat.fieldErrors)) {
      if (messages && messages.length) fieldErrors[key] = messages[0];
    }
    const keys = Object.keys(fieldErrors);
    const form = flat.formErrors[0];
    return fail(
      keys.length ? `Some values aren't valid: ${keys.map(label).join(', ')}.` : (form ?? `These values aren't valid for ${def.label}.`),
      fieldErrors,
    );
  }
  const output = (parsed.data ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  // Only what was proposed: defaults the schema adds are left to the model,
  // and a value the schema turns into "nothing" is not written (as on the screen).
  for (const key of Object.keys(builtIn)) {
    if (!(key in output)) { dropped.push(key); continue; }
    if (output[key] !== undefined) values[key] = output[key];
  }
  Object.assign(values, custom);

  // 4. Pipeline status (read-only).
  await checkPipelineStatus(input, values, fieldErrors);
  if (Object.keys(fieldErrors).length) {
    return fail(`Some values aren't valid: ${Object.keys(fieldErrors).map(label).join(', ')}.`, fieldErrors);
  }

  const warnings: string[] = [];
  if (dropped.length) {
    warnings.push(`Not included: ${dropped.map(label).join(', ')}. The ${cap.labels.singular.toLowerCase()} form doesn't take ${dropped.length === 1 ? 'it' : 'them'}.`);
  }
  return { ok: true, values, writable, labels, warnings };
}
