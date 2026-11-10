import type { FormRefValue, FormValue, SideEffect, Totals } from '../contracts/views';
import type { WriteFormField } from '../registry/types';
import type {
  CustomFieldDef, FormContext, SealedLine, StackInput, StackResult, StoredRef, StoredRefValue, WriteRuleResult,
} from '../writes/workflow-types';
import { COMPUTED_MONEY_WRITE_KEYS, WRITE_FORBIDDEN_KEYS } from '../../internal/crm-read.service';
import { isMaskedPiiValue } from '../../native-crm/shared/pii-update';
import { computeDocumentTotals } from '../../native-crm/shared/document-totals';
import type { DocumentTotals } from '../../native-crm/shared/document-totals';
import { isDayKey } from '../grammar/dates';
import { utcToWallTime, wallTimeToUtc } from '../grammar/wall-time';
import { MASKED_VALUE_MESSAGE, fieldLabel, looksMasked, screenSchemaFor } from './validate';
import { recheckRefs, storedValueOf } from './references';
import { crmUserRef } from './crm-users';
import { workflowSideEffects } from './side-effects';
import { LINE_WRITE_KEYS, checkLines, linesToWrite, recheckCatalogLines, totalsViewOf } from './document-lines';

/* The guided forms' validation stack (Increment 6, spec B11). The draft
 * steps (start, validate, fill), review and confirm all run it on the form
 * as the person sees it:
 *
 *   1. keys: only the form's fields count; forbidden, computed and
 *      privileged keys are never fields (asserted anyway);
 *   2. which fields: a create takes every field; an update only those the
 *      person changed (origin other than 'source'), and a masked field only
 *      when something was typed in it (empty keeps the stored value);
 *   3. shape and conversion to what the record stores (displayToWrite):
 *      trimmed text, a number in range, a day, a tenant wall time as an
 *      instant (DST-safe; a custom field keeps the wall time, as the screens
 *      store it), an option, the stored key of a picked record;
 *   4. a masked-looking value is refused for PII and the work order
 *      address, so a value the caller only saw masked is never written;
 *   5. the screen's own Zod schema on the built-in keys, keeping its output;
 *   6. required fields: missing on a create, never emptied on an update; a
 *      required custom field a chat form can't fill sends the person to
 *      the page (L18);
 *   7, 8. on review and confirm, every picked record is read again under
 *      the caller's scope now, and every owner must still be a CRM user
 *      (L25). These run first, so the conversion uses the fresh labels;
 *   9. the module's own read-only rules;
 *  10. the side-effect lines.
 *
 * Every layer collects its errors, so the form shows them all at once. On
 * confirm ('commit') any error is fatal: the result is not ready and holds
 * nothing to write. Nothing here writes.
 *
 * A document create (Increment 7, spec B5.4; a WriteCap with `lines`) also
 * carries its lines beside the form: they become the write keys `services`
 * and `parts` before the screen's schema runs, the catalog rows are priced
 * again on review and confirm, and the totals come from the service's own
 * totals code on the payload the schema left (the preview equals what is
 * stored, M5). A create made from another record (an invoice from a work
 * order) takes that record's write values, and the fields they fill are
 * neither converted, checked nor read again. Line errors count as errors. */

const PICK_RECORD = 'Pick a record from the list.';
const ADD_TIME = 'Add a time.';
const MIDNIGHT = "Midnight can't be saved as a time. Pick another time.";
const CANT_CLEAR = "This field can't be emptied.";
const OWNER_NOT_USER = 'Pick a CRM user as the owner.';
const NOT_ALLOWED = "This field can't be set from the assistant.";
const TEXT_MESSAGE = 'Enter text.';
const EMAIL_MESSAGE = 'Enter a valid email address.';
const NUMBER_MESSAGE = 'Enter a number.';
const WHOLE_NUMBER_MESSAGE = 'Enter a whole number.';
const PERCENT_MESSAGE = 'Enter a percentage from 0 to 100.';
const DATE_MESSAGE = 'Enter a valid date.';
const DATETIME_MESSAGE = 'Enter a valid date and time.';
const OPTION_MESSAGE = 'Pick one of the listed options.';
const BOOLEAN_MESSAGE = 'Choose yes or no.';

const timeGapMessage = (time: string, date: string, tz: string, setTo: string) =>
  `There is no ${time} on ${date} in ${tz} because the clocks change. It was set to ${setTo}.`;
const timeOverlapMessage = (time: string, date: string, tz: string) =>
  `${time} happens twice on ${date} in ${tz}. The first one was used.`;
const customOnlyOnPageMessage = (singular: string, label: string) =>
  `This ${singular} needs ${label}, which can only be filled on its page.`;
const cantSaveValuesMessage = (singular: string) => `These values can't be saved for this ${singular}.`;
/* A document's lines (Increment 7, spec B12). */
const LINES_LABEL = 'Lines';
const linesCantSaveMessage = (singular: string) => `These lines can't be saved from the assistant. Use the ${singular} page.`;
const linesCantTotalMessage = (singular: string) => `These lines can't be totalled here. Use the ${singular} page.`;

const CUSTOM_PREFIX = 'customFields.';
/** Fields whose picked records are read again at review and confirm (owners are checked as users). */
const RECORD_REF_KINDS: ReadonlySet<WriteFormField['kind']> = new Set(['ref', 'ref_many', 'related']);
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

type Conversion = { values?: Record<string, unknown>; error?: string; warning?: string; empty: boolean };

function isEmptyValue(value: FormValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim();
  return Array.isArray(value) && value.length === 0;
}

function isRefValue(value: unknown): value is FormRefValue {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { ref?: unknown }).ref === 'string';
}

function isCustomKey(key: string): boolean {
  return key.startsWith(CUSTOM_PREFIX);
}

function customKeyOf(def: CustomFieldDef): string {
  return def.key.startsWith(CUSTOM_PREFIX) ? def.key : `${CUSTOM_PREFIX}${def.fieldKey}`;
}

function customDefOf(ctx: FormContext, key: string): CustomFieldDef | undefined {
  return ctx.customFields.find((def) => customKeyOf(def) === key);
}

/** Required on create; never emptied on an update (L18). A custom field also by its own definition. */
function isRequired(field: WriteFormField, ctx: FormContext): boolean {
  return field.required || (isCustomKey(field.key) && !!customDefOf(ctx, field.key)?.required);
}

/** The keys a field writes: a related record its two or three, an owner also the keys it sets (leadOwner). */
function writeKeysOf(field: WriteFormField): string[] {
  if (field.kind === 'related') {
    return field.related?.writesLabel ? ['relatedModule', 'relatedId', 'relatedLabel'] : ['relatedModule', 'relatedId'];
  }
  return [field.key, ...(field.sets ?? []).map((s) => s.key)];
}

/** What an emptied field writes on an update, as the screens send it: null for numbers and yes/no, [] for
 * lists, '' for everything else (each related key too). */
function clearedValues(field: WriteFormField): Record<string, unknown> {
  const blank = field.kind === 'number' || field.kind === 'money' || field.kind === 'percent' || field.kind === 'boolean' ? null
    : field.kind === 'multiselect' || field.kind === 'ref_many' ? [] : '';
  return Object.fromEntries(writeKeysOf(field).map((key) => [key, key === field.key ? blank : '']));
}

function numberOf(value: FormValue): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The values an option field takes. A stage: the tenant's active stages (none active takes nothing, as the
 * service decides). An enum: the schema's or the cap's values; unknown, the screen's schema decides. */
function allowedValues(field: WriteFormField, ctx: FormContext): readonly string[] | undefined {
  if (field.kind === 'stage') {
    const pipeline = field.options?.from === 'pipeline' ? field.options.pipeline : undefined;
    return (ctx.stageOptions[field.key] ?? (pipeline ? ctx.stageOptions[pipeline] : undefined) ?? []).map((s) => s.key);
  }
  const listed = ctx.enumOptions[field.key];
  if (listed?.length) return listed;
  return field.options?.from === 'static' ? field.options.values : undefined;
}

/** The picked record is of the module the field takes: a CRM user for an owner, one of a related field's
 * modules (the one the form names), else the ref's own module. */
function pickFits(field: WriteFormField, picked: StoredRef, value: FormRefValue): boolean {
  if (field.kind === 'owner_user') return picked.module === 'user';
  if (field.kind === 'related') {
    return !!field.related?.modules.includes(picked.module) && (value.module === undefined || value.module === picked.module);
  }
  return !!field.ref && picked.module === field.ref.module;
}

function datetimeToWrite(field: WriteFormField, value: FormValue, ctx: FormContext): Conversion {
  if (typeof value !== 'string') return { error: DATETIME_MESSAGE, empty: false };
  const text = value.trim();
  // A day with no time is never saved as midnight (L14).
  if (isDayKey(text)) return { error: ADD_TIME, empty: false };
  const m = DATETIME_RE.exec(text);
  const hour = m ? Number(m[2]) : NaN;
  const minute = m ? Number(m[3]) : NaN;
  if (!m || !isDayKey(m[1]) || !(hour <= 23) || !(minute <= 59)) return { error: DATETIME_MESSAGE, empty: false };
  if (hour === 0 && minute === 0) return { error: MIDNIGHT, empty: false };
  const [year, month, day] = m[1].split('-').map(Number);
  const { at, adjusted } = wallTimeToUtc({ year, month, day, hour, minute }, ctx.timezone);
  const wall = utcToWallTime(at, ctx.timezone);
  const asked = `${m[2]}:${m[3]}`;
  const warning = adjusted === 'gap' ? timeGapMessage(asked, m[1], ctx.timezone, wall.time)
    : adjusted === 'overlap' ? timeOverlapMessage(asked, m[1], ctx.timezone) : undefined;
  // A custom date-time is stored as the screens store it (CustomFieldRenderer's datetime-local input): the
  // tenant's wall time with no zone, as a clock change moved it. A built-in one is the instant.
  const stored = isCustomKey(field.key) ? `${wall.date}T${wall.time}` : at.toISOString();
  return { values: { [field.key]: stored }, empty: false, ...(warning ? { warning } : {}) };
}

/** The stack on one form: the write it would make (`values`), everything that keeps it from being written
 * (field errors, missing required fields, form errors) and what the card says around it. `ready` is true
 * only when nothing keeps it from being written. */
export async function runFormStack(input: StackInput): Promise<StackResult> {
  const { wf, op, mode, identity, tenant, ctx, related, fields, form, origins } = input;
  const singular = input.cap.labels.singular.toLowerCase();
  const fieldErrors: Record<string, string> = {};
  const missing: string[] = [];
  const formErrors: string[] = [];
  const warnings: string[] = [];
  const quickPicks: StackResult['quickPicks'] = {};
  const labels: Record<string, string> = {};
  const writable: string[] = [];
  const values: Record<string, unknown> = {};
  let refs: Record<string, StoredRefValue> = { ...input.refs };
  // Increment 7, a document create: its lines, the record it is made from, and what they give. Nothing changes
  // for an update or for a module without lines.
  const spec = op === 'create' ? wf.cap.lines : undefined;
  const source = spec ? input.source : undefined;
  let lines: SealedLine[] = spec ? [...(input.lines ?? [])] : [];
  const lineErrors: Record<string, string> = {};
  let totals: Totals | null = null;
  let documentTotals: DocumentTotals | null = null;

  const fail = (key: string, message: string) => { fieldErrors[key] ??= message; };
  const hasErrors = () => Object.keys(fieldErrors).length > 0 || missing.length > 0 || formErrors.length > 0 || Object.keys(lineErrors).length > 0;
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  /** A field error that also takes the field's keys out of the write. */
  const drop = (key: string, message: string) => {
    fail(key, message);
    const field = fieldByKey.get(key);
    for (const writeKey of field ? writeKeysOf(field) : [key]) delete values[writeKey];
  };
  const finish = (sideEffects: SideEffect[]): StackResult => {
    const ready = !hasErrors();
    return {
      values: ready || mode !== 'commit' ? values : {}, refs, fieldErrors, missing, formErrors: [...new Set(formErrors)],
      warnings: [...new Set(warnings)], sideEffects, labels, writable, quickPicks, ready,
      ...(spec ? { lines, lineErrors, totals, documentTotals } : {}),
    };
  };

  // 1. Keys. Labels and the writable keys come from the same fields.
  const privileged = new Set(wf.cap.privilegedFields);
  const forbidden = (key: string) => WRITE_FORBIDDEN_KEYS.has(key) || COMPUTED_MONEY_WRITE_KEYS.has(key);
  const addWritable = (key: string, label: string) => {
    labels[key] ??= label;
    if (!writable.includes(key)) writable.push(key);
  };
  const formKeyOf: Record<string, string> = {};
  for (const field of fields) {
    labels[field.key] = field.label;
    const keys = writeKeysOf(field);
    for (const key of keys) formKeyOf[key] ??= field.key;
    const allowed = isCustomKey(field.key)
      ? wf.cap.customFields && !!customDefOf(ctx, field.key)?.writable
      : field.key !== 'customFields' && !forbidden(field.key) && !privileged.has(field.key) && !keys.some(forbidden);
    if (allowed) keys.forEach((key) => addWritable(key, field.label));
    else fail(field.key, NOT_ALLOWED);
  }
  // A document's lines write services and parts. The record a create is made from gives its own write values
  // (customerId, workOrderId, ...): never a system, computed or line key. `extraKeys`: those no field writes.
  if (spec) for (const key of LINE_WRITE_KEYS) addWritable(key, LINES_LABEL);
  const fixedValues: Record<string, unknown> = {};
  const extraKeys = new Set<string>(spec ? LINE_WRITE_KEYS : []);
  for (const [key, value] of Object.entries(source?.fixed ?? {})) {
    if (forbidden(key) || LINE_WRITE_KEYS.has(key) || key === 'customFields' || isCustomKey(key)) {
      formErrors.push(cantSaveValuesMessage(singular));
      continue;
    }
    fixedValues[key] = value;
    addWritable(key, fieldLabel(key, input.cap, {}));
    if (formKeyOf[key] === undefined) extraKeys.add(key);
  }
  if (wf.cap.customFields) for (const def of ctx.customFields) if (def.writable) addWritable(customKeyOf(def), def.label);
  if (mode === 'commit' && hasErrors()) return finish([]);

  // 2. Which fields. Those the record a create is made from fills take its values (not converted, checked or read).
  const masked = new Set(input.masked);
  const fixedFields = new Set(source?.fixedKeys ?? []);
  const active = fields.filter((field) => {
    if (fieldErrors[field.key] !== undefined) return false;
    if (fixedFields.has(field.key)) return false;
    if (op === 'create') return true;
    const origin = origins[field.key];
    return origin !== undefined && origin !== 'source' && !(masked.has(field.key) && isEmptyValue(form[field.key]));
  });
  // A record picked for a field the person has since emptied is no longer picked.
  for (const field of active) if (isEmptyValue(form[field.key])) delete refs[field.key];

  // 7, 8. Review and confirm: the picked records again, under the caller's scope now. An update re-reads only
  // the changed ones; the others still give their parent to a "within" check (site within customer). A record
  // the source fixed is never read again here (its own checks run in the module's rules).
  if (mode !== 'draft') {
    const picked: Record<string, StoredRefValue> = {};
    for (const field of fields) {
      if (fixedFields.has(field.key)) continue;
      if (RECORD_REF_KINDS.has(field.kind) && refs[field.key] !== undefined && !isEmptyValue(form[field.key])) picked[field.key] = refs[field.key];
    }
    const recheck = active.filter((field) => picked[field.key] !== undefined).map((field) => field.key);
    if (recheck.length) {
      const checked = await recheckRefs(fields, picked, op === 'create' ? 'all' : new Set(recheck), {
        identity, tenant, gate: related, focus: null, ctx,
      });
      refs = { ...refs, ...checked.refs };
      for (const [key, message] of Object.entries(checked.errors)) fail(key, message);
    }
    for (const field of active) {
      const value = form[field.key];
      const ref = refs[field.key];
      if (field.kind !== 'owner_user' || !isRefValue(value) || !ref || Array.isArray(ref) || ref.id !== value.ref) continue;
      const user = await crmUserRef(identity.tenantId, ref.id);
      if (user) refs[field.key] = user;
      else fail(field.key, OWNER_NOT_USER);
    }
    // The catalog rows priced again under the caller's gates now (M12): a new price is taken with a warning,
    // an item gone, inactive or out of sight is the row's error. Carried rows keep their source's prices.
    if (spec && lines.length) {
      const rechecked = await recheckCatalogLines(lines, related, ctx.branchCurrency);
      lines = rechecked.lines;
      Object.assign(lineErrors, rechecked.errors);
      warnings.push(...rechecked.warnings);
    }
    if (mode === 'commit' && hasErrors()) return finish([]);
  }

  // 3, 4. Shape and conversion, then masked values.
  const converted = new Map<string, { values: Record<string, unknown>; empty: boolean }>();
  for (const field of active) {
    if (fieldErrors[field.key] !== undefined) continue;
    const value = form[field.key] ?? null;
    const out = displayToWrite(field, value, ctx, refs[field.key]);
    if (out.warning) warnings.push(out.warning);
    if (out.error) { fail(field.key, out.error); continue; }
    if (!out.empty && (field.pii || field.refuseMasked) && typeof value === 'string'
      && (looksMasked(value) || isMaskedPiiValue(field.key, value))) {
      fail(field.key, MASKED_VALUE_MESSAGE);
      continue;
    }
    converted.set(field.key, { values: out.values ?? {}, empty: out.empty });
  }

  // 6. Required fields (before Zod, so a missing key isn't also a Zod error).
  for (const field of active) {
    if (!converted.get(field.key)?.empty || !isRequired(field, ctx)) continue;
    if (op === 'create') missing.push(field.key);
    else { fail(field.key, CANT_CLEAR); converted.delete(field.key); }
  }
  if (op === 'create') {
    for (const def of ctx.customFields) {
      if (def.required && (!def.writable || !fieldByKey.has(customKeyOf(def)))) formErrors.push(customOnlyOnPageMessage(singular, def.label));
    }
  }
  // A document's lines: too many, none while the create needs one, a quantity out of range.
  if (spec) for (const [key, message] of Object.entries(checkLines(lines, spec, !!source))) lineErrors[key] ??= message;

  // The write: a create every value that isn't empty (defaults count), an update every changed value (an
  // emptied one clears the field). A document's lines as services and parts (both, always), then the values
  // the record it is made from gives.
  for (const c of converted.values()) if (op === 'update' || !c.empty) Object.assign(values, c.values);
  if (spec) Object.assign(values, linesToWrite(lines));
  Object.assign(values, fixedValues);

  // 5. The screen's own schema on the built-in keys, keeping its output (custom fields keep the checks above,
  // as on /crm-write). An issue goes to the form field that wrote the key; one on the lines is the list's own
  // error, one on a value only the source gives is the form's.
  const builtIn = Object.fromEntries(Object.entries(values).filter(([key]) => !isCustomKey(key)));
  const unsaved = (key: string) => {
    if (LINE_WRITE_KEYS.has(key)) lineErrors.lines ??= linesCantSaveMessage(singular);
    else formErrors.push(cantSaveValuesMessage(singular));
  };
  const schema = screenSchemaFor(wf.cap.module, op);
  if (!schema) {
    formErrors.push(`This ${singular} can't be saved from the assistant.`);
  } else {
    const parsed = schema.safeParse(builtIn);
    if (parsed.success) {
      const output = (parsed.data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(builtIn)) {
        if (extraKeys.has(key)) {
          if (output[key] !== undefined) values[key] = output[key];
          else { delete values[key]; unsaved(key); }
          continue;
        }
        const formKey = formKeyOf[key] ?? key;
        if (fieldErrors[formKey] !== undefined) continue;
        // A value the schema drops can't be saved; an emptied one means the screen can't empty it either.
        if (output[key] === undefined) drop(formKey, converted.get(formKey)?.empty ? CANT_CLEAR : NOT_ALLOWED);
        else values[key] = output[key];
      }
    } else {
      for (const issue of parsed.error.issues) {
        const key = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
        if (key !== undefined && extraKeys.has(key)) {
          unsaved(key);
          continue;
        }
        const formKey = key === undefined ? undefined : formKeyOf[key];
        if (formKey === undefined) {
          formErrors.push(key === undefined ? cantSaveValuesMessage(singular)
            : customOnlyOnPageMessage(singular, fieldLabel(key, input.cap, {})));
        } else if (op === 'create' && converted.get(formKey)?.empty) {
          if (!missing.includes(formKey)) missing.push(formKey);
        } else {
          drop(formKey, converted.get(formKey)?.empty ? CANT_CLEAR : issue.message);
        }
      }
    }
  }

  // The totals, by the service's own code on the payload the schema left (M5), for lines that can be saved
  // and a discount and GST that can (C3); otherwise they stay pending (null). Totals that can't be shown (a
  // line without a price) are the list's error.
  if (spec && !Object.keys(lineErrors).length && fieldErrors.discount === undefined && fieldErrors.gstPercentage === undefined) {
    let t: DocumentTotals | null = null;
    try {
      t = computeDocumentTotals(spec.totals, { services: values.services, parts: values.parts, discount: values.discount, gstPercentage: values.gstPercentage });
    } catch {
      t = null;
    }
    // What the record will store: the back-fill when the totals give one, else the payload's value.
    totals = t && totalsViewOf(t, {
      discount: t.backfill.discount ?? values.discount, gstPercentage: t.backfill.gstPercentage ?? values.gstPercentage,
    }, ctx.branchCurrency);
    if (totals) documentTotals = t;
    else lineErrors.lines ??= linesCantTotalMessage(singular);
  }
  if (mode === 'commit' && hasErrors()) return finish([]);

  // 9. The module's own rules (read-only; duplicates, availability, visibility, linked records; a document's
  // lines, the record it is made from and its totals).
  let ruled: WriteRuleResult | null = null;
  if (wf.rules) {
    ruled = await wf.rules.check({
      op, mode, identity, tenant, ctx, values: { ...values }, form, refs, changed: new Set(active.map((field) => field.key)),
      record: input.record, related,
      ...(spec ? { lines, totals: documentTotals } : {}), ...(source ? { source } : {}),
    });
    for (const [key, message] of Object.entries(ruled.fieldErrors)) drop(key, message);
    formErrors.push(...ruled.formErrors);
    if (ruled.blocked) formErrors.push(ruled.blocked);
    warnings.push(...ruled.warnings);
    Object.assign(quickPicks, ruled.quickPicks ?? {});
  }
  if (mode === 'commit' && hasErrors()) return finish([]);

  // 10. The side-effect lines.
  return finish(workflowSideEffects(wf, op, ruled?.sideEffects ?? []));
}

/** One form value as the write stores it, by the field's kind (spec B11, layer 3). An empty value gives
 * `empty` and the values that clear the field (an update writes them; a create leaves the field out). A
 * daylight-saving gap or overlap gives a warning; anything that can't be stored gives an error. */
export function displayToWrite(field: WriteFormField, value: FormValue, ctx: FormContext, ref?: StoredRefValue):
  { values?: Record<string, unknown>; error?: string; warning?: string; empty: boolean } {
  if (isEmptyValue(value)) return { values: clearedValues(field), empty: true };
  const write = (stored: unknown): Conversion => ({ values: { [field.key]: stored }, empty: false });
  const refuse = (error: string): Conversion => ({ error, empty: false });

  switch (field.kind) {
    case 'text': case 'longtext': case 'phone': case 'email': {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return refuse(TEXT_MESSAGE);
      const text = String(value).trim();
      if (field.maxLength !== undefined && text.length > field.maxLength) return refuse(`Use at most ${field.maxLength} characters.`);
      if (field.kind === 'email' && !(text.includes('@') && text.includes('.'))) return refuse(EMAIL_MESSAGE);
      return write(text);
    }
    case 'number': case 'money': case 'percent': {
      const n = numberOf(value);
      if (n === null) return refuse(NUMBER_MESSAGE);
      if (field.integer && !Number.isInteger(n)) return refuse(WHOLE_NUMBER_MESSAGE);
      if (field.kind === 'percent' && (n < 0 || n > 100)) return refuse(PERCENT_MESSAGE);
      if (field.min !== undefined && n < field.min) return refuse(`Enter ${field.min} or more.`);
      if (field.max !== undefined && n > field.max) return refuse(`Enter ${field.max} or less.`);
      return write(n);
    }
    case 'date':
      // The day picked, as the screens store it (UTC midnight of that day).
      return typeof value === 'string' && isDayKey(value.trim()) ? write(value.trim()) : refuse(DATE_MESSAGE);
    case 'datetime':
      return datetimeToWrite(field, value, ctx);
    case 'enum': case 'stage': {
      const allowed = allowedValues(field, ctx);
      if (typeof value !== 'string' || (allowed && !allowed.includes(value.trim()))) return refuse(OPTION_MESSAGE);
      return write(value.trim());
    }
    case 'multiselect': {
      if (!Array.isArray(value) || !(value as unknown[]).every((v) => typeof v === 'string')) return refuse(OPTION_MESSAGE);
      const chosen = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
      const allowed = allowedValues(field, ctx);
      if (allowed && chosen.some((v) => !allowed.includes(v))) return refuse(OPTION_MESSAGE);
      return chosen.length ? write(chosen) : { values: clearedValues(field), empty: true };
    }
    case 'boolean':
      return typeof value === 'boolean' ? write(value) : refuse(BOOLEAN_MESSAGE);
    case 'ref': case 'owner_user': case 'related': {
      // Only a record the server resolved (the stored ref of the same id) is ever written.
      const picked = ref && !Array.isArray(ref) ? ref : undefined;
      if (!isRefValue(value) || !picked || picked.id !== value.ref || !pickFits(field, picked, value)) return refuse(PICK_RECORD);
      if (field.kind === 'related') {
        const out: Record<string, unknown> = { relatedModule: picked.module, relatedId: storedValueOf(field, picked) };
        // Stored exactly as the screen stores it (FsRelationPicker.tsx): number, em dash, name; or the name.
        if (field.related?.writesLabel) out.relatedLabel = picked.number ? `${picked.number} — ${picked.label}` : picked.label;
        return { values: out, empty: false };
      }
      const out: Record<string, unknown> = { [field.key]: storedValueOf(field, picked) };
      for (const set of field.sets ?? []) out[set.key] = picked.label;
      return { values: out, empty: false };
    }
    case 'ref_many': {
      if (!Array.isArray(value) || !(value as unknown[]).every(isRefValue)) return refuse(PICK_RECORD);
      const max = field.ref?.maxItems;
      if (max !== undefined && value.length > max) return refuse(`Pick at most ${max}.`);
      const stored = Array.isArray(ref) ? ref : ref ? [ref] : [];
      const keys: string[] = [];
      for (const item of value as FormRefValue[]) {
        const picked = stored.find((s) => s.id === item.ref && pickFits(field, s, item));
        if (!picked) return refuse(PICK_RECORD);
        const key = storedValueOf(field, picked);
        if (!keys.includes(key)) keys.push(key);
      }
      return write(keys);
    }
    default:
      return refuse(NOT_ALLOWED);
  }
}

function canonicalOf(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalOf);
  if (typeof value === 'object') {
    if ((value as { _bsontype?: unknown })._bsontype) return String(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalOf(v);
    }
    return out;
  }
  return value;
}

/** Canonical equality of two write payloads (dates as ISO, ObjectIds as hex, keys in any order; a key whose
 * value is undefined counts as absent). Types are kept: '' is not null and '5' is not 5. */
export function sameWriteValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalOf(a)) === JSON.stringify(canonicalOf(b));
}
