import { readFieldKeysFor } from '../../internal/crm-read.service';
import { addDaysToKey } from '../../daily-events/daily-events.time';
import { logger } from '../../../utils/logger';
import { ModuleKeySchema } from '../contracts/plan';
import type { WriteIntent } from '../contracts/plan';
import { isKnownAppLink } from '../contracts/routes';
import { FORM_CAPS, FormBlockSchema, ReviewBlockSchema, collectLinks } from '../contracts/views';
import type {
  AppLink, Cell, ClarifyBlock, ClarifyOption, EntityChoice, EntityRef, FormBlock, FormField, FormRefValue, FormValue, FullFormAction,
  NoticeBlock, OperationConfirmation, ResultBlock, ReviewBlock,
} from '../contracts/views';
import type { EntityMatch } from '../query/resolve-entity';
import type { ReadContext, StatusInfo, StatusOption } from '../query/execute-list';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteFieldKind, WriteFormField } from '../registry/types';
import { wallTimeToUtc } from '../grammar/wall-time';
import { digestOf, shownValue, textOf, valueCell } from '../operations/operation.service';
import { customDateTimeOf } from '../operations/prefill';
import { fieldLabel } from '../operations/validate';
import type {
  FormBlockInput, FormContext, PrefillValue, StoredRef, StoredRefValue, WorkflowReply, WorkflowReviewInput,
} from '../writes/workflow-types';
import { sourceRefFor } from './compose';
import type { ComposedAnswer } from './compose';
import { humanize } from './chips';
import { scrubIds } from './fallback-text';

/* The guided forms' view blocks (Increment 6, B-PREFILL): the FormBlock, the
 * workflow ReviewBlock, the choice of target when a name matches several
 * records, workflow notices, and the composed answer for each lifecycle
 * reply. Every block is checked against its schema and the route table
 * before it leaves (fail closed): a form or review that can't be shown throws
 * FormComposeError and is never sent half-built. Texts are B20's.
 *
 * Increment 7 (spec B5.7): a document's lines and totals go into the form and
 * the review as the lifecycle built them; their errors ('lines', a row's
 * 'lines.<key>') stay on the lines; a create made from another record is
 * titled with its number and the fields it fills are read-only. */

/** A FormBlock that failed its own schema or link check: nothing is shown. */
export class FormComposeError extends Error {}

/** B20: the help of a field whose stored value is hidden for the caller's role. */
export const MASKED_FIELD_HELP = 'Hidden for your role. Type a new value to replace it, or leave it empty to keep it.';
/** B20 REF_HIDDEN: a reference field whose module the caller can't read. */
const refHiddenText = (plural: string) => `You can't look up ${plural} here.`;
const REQUIRED_TEXT = 'Required.';
const FULL_FORM_LABEL = 'Continue in full form';
const ASSIGN_TO_ME = 'Assign to me';
/** At most this long, as a select option's value must be (contracts/views.ts FormFieldSchema). */
const OPTION_VALUE_MAX = 80;
const HEX_ID = /^[a-f0-9]{24}$/i;
const CUSTOM_PREFIX = 'customFields.';
/** The keys a related field writes; the review shows them as one row. */
const RELATED_KEYS: ReadonlySet<string> = new Set(['relatedModule', 'relatedId', 'relatedLabel']);
/** The write keys of a document's lines (operations/document-lines.ts): shown as its lines, never as review rows. */
const LINE_KEYS: ReadonlySet<string> = new Set(['services', 'parts']);
/** An error on a document's lines: the list's own ('lines') or a row's ('lines.<key>'). */
const isLineErrorKey = (key: string) => key === 'lines' || key.startsWith('lines.');
const IMPERATIVE = { create: 'Create', update: 'Update', delete: 'Delete' } as const;
const REVIEW_VERB = { create: 'create', update: 'change', delete: 'delete' } as const;
/** A choice's place among choices that read alike, newest first (as views/clarify.ts words it). */
const ORDINALS = ['Newest', 'Second newest', 'Third newest'];
const MAX_CHOICE_LABEL = 120;
/** The notice code of a refusal shown in the chat, by its status. */
const REFUSED_CODES: Readonly<Record<number, string>> = { 403: 'no_permission', 404: 'form_closed' };

/** The browser input of each field kind (spec B10). */
const INPUTS: Readonly<Record<WriteFieldKind, FormField['input']>> = {
  text: 'text', longtext: 'textarea', email: 'email', phone: 'phone', number: 'number', money: 'money', percent: 'percent',
  date: 'date', datetime: 'datetime', enum: 'select', stage: 'select', multiselect: 'multiselect', boolean: 'boolean',
  ref: 'record_ref', related: 'record_ref', owner_user: 'record_ref', ref_many: 'record_refs',
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function singularOf(module: string): string {
  return (getModuleCap(module)?.labels.singular ?? 'record').toLowerCase();
}

function pluralOf(module: string): string {
  return (getModuleCap(module)?.labels.plural ?? 'records').toLowerCase();
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** A history summary: one line, no record ids, and never ending in "?" (the
 * AI service reads a reply ending in "?" as a question back). */
function summaryOf(text: string): string {
  return clip(scrubIds(text.replace(/\s+/g, ' ').trim()).replace(/\?+$/, '.'), 300) || 'Done.';
}

/* ── Form values ───────────────────────────────────────────────────────── */

function refValueOf(value: unknown): FormRefValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as { ref?: unknown; label?: unknown; module?: unknown };
  if (typeof v.ref !== 'string' || !HEX_ID.test(v.ref)) return undefined;
  const module = typeof v.module === 'string' && ModuleKeySchema.safeParse(v.module).success ? v.module : undefined;
  return { ref: v.ref, label: clip(typeof v.label === 'string' ? v.label : '', 200), ...(module ? { module } : {}) };
}

/** A value cut to what a form block may carry; undefined when it can't be one (it is left out). */
function formValueOf(value: unknown): FormValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, FORM_CAPS.textarea);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return (value as string[]).slice(0, FORM_CAPS.options).map((v) => v.slice(0, 120));
    const refs = value.map(refValueOf);
    return refs.every((r): r is FormRefValue => r !== undefined) ? (refs as FormRefValue[]).slice(0, FORM_CAPS.multi) : undefined;
  }
  return refValueOf(value);
}

/* ── Fields ────────────────────────────────────────────────────────────── */

function visibleRelatedModules(field: WriteFormField, ctx: FormContext): string[] {
  return (field.related?.modules ?? []).filter((m) => ctx.refAccess[m] === 'ok').slice(0, 10);
}

/** The plural of a referenced module the caller can't read (the field is
 * then read-only), or null. A related field is read-only only when none of
 * its modules can be read. */
function hiddenModuleOf(field: WriteFormField, ctx: FormContext): string | null {
  if ((field.kind === 'ref' || field.kind === 'ref_many') && field.ref) {
    return ctx.refAccess[field.ref.module] === 'ok' ? null : pluralOf(field.ref.module);
  }
  if (field.kind === 'related') return visibleRelatedModules(field, ctx).length ? null : 'records';
  return null;
}

/** What a picker searches: the module (owners: CRM users; related: the
 * modules the caller can read) and the parent field it depends on, when the
 * parent is on the form. */
function refSpecOf(field: WriteFormField, ctx: FormContext, keys: ReadonlySet<string>): FormField['ref'] | undefined {
  switch (field.kind) {
    case 'ref': case 'ref_many': {
      if (!field.ref) return undefined;
      const parent = field.ref.within?.field;
      return { module: field.ref.module, ...(parent && keys.has(parent) ? { dependsOn: parent } : {}) };
    }
    case 'owner_user':
      return { module: 'user' };
    case 'related': {
      const visible = visibleRelatedModules(field, ctx);
      const first = visible[0] ?? field.related?.modules[0];
      return first ? { module: first, ...(visible.length ? { modules: visible } : {}) } : undefined;
    }
    default:
      return undefined;
  }
}

/** A select's options: a stage's tenant labels and colours, or an enum's
 * values (humanized; a custom field's own words as written). An update also
 * offers the record's own value when it is no longer an option, so the form
 * shows what is stored (a stage switched off). */
function selectOptions(field: WriteFormField, input: FormBlockInput): FormField['options'] | undefined {
  const { ctx } = input;
  let options: Array<{ value: string; label: string; color?: string }>;
  if (field.kind === 'stage') {
    options = (ctx.stageOptions[field.key] ?? []).map((s) => ({ value: s.key, label: s.label, ...(s.color ? { color: s.color } : {}) }));
  } else if (field.kind === 'enum' || field.kind === 'multiselect') {
    const custom = field.key.startsWith(CUSTOM_PREFIX);
    const values = ctx.enumOptions[field.key] ?? (field.options?.from === 'static' ? field.options.values : []);
    options = values.map((value) => ({ value, label: custom ? value : humanize(value) }));
  } else {
    return undefined;
  }
  if (input.origins[field.key] === 'source') {
    const current = input.form[field.key];
    for (const value of Array.isArray(current) ? current : [current]) {
      if (typeof value === 'string' && value && !options.some((o) => o.value === value)) options.push({ value, label: humanize(value) });
    }
  }
  return options.filter((o) => o.value.length <= OPTION_VALUE_MAX).slice(0, FORM_CAPS.options).map((o) => ({
    value: o.value, label: clip(o.label || o.value, 120), ...(o.color && o.color.length <= 16 ? { color: o.color } : {}),
  }));
}

function boundsOf(field: WriteFormField): { min?: number; max?: number } {
  if (field.kind === 'percent') return { min: 0, max: 100 };
  if (field.kind !== 'number' && field.kind !== 'money') return {};
  return { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) };
}

function maxLengthOf(field: WriteFormField): { maxLength?: number } {
  const cap = field.kind === 'longtext' ? FORM_CAPS.textarea
    : field.kind === 'text' || field.kind === 'email' || field.kind === 'phone' ? FORM_CAPS.text : 0;
  if (!cap) return {};
  return { maxLength: Math.max(1, Math.min(Math.floor(field.maxLength ?? cap), FORM_CAPS.textarea)) };
}

/** An amount's currency: a deal's own currency field when the form has one, else the branch's. */
function currencyOf(input: FormBlockInput): string | null {
  const own = input.fields.some((f) => f.key === 'currency') ? input.form.currency : undefined;
  const currency = typeof own === 'string' && own.trim() ? own.trim() : input.ctx.branchCurrency;
  return currency ? clip(currency, 8) : null;
}

/** The field's own one-click values: "Assign to me" (the caller's staff
 * record, or their user for an owner) when they have one, and today or
 * tomorrow as tenant-local days. */
function ownPicks(field: WriteFormField, ctx: FormContext): Array<{ label: string; value: FormValue }> {
  const picks: Array<{ label: string; value: FormValue }> = [];
  for (const pick of field.quickPicks ?? []) {
    if (pick === 'assign_to_me') {
      const me = field.kind === 'owner_user' ? ctx.ownUser : field.ref?.module === 'staff' ? ctx.ownStaff : null;
      if (!me || !HEX_ID.test(me.id)) continue;
      const value: FormRefValue = { ref: me.id, label: clip(me.label, 200) };
      picks.push({ label: ASSIGN_TO_ME, value: field.kind === 'ref_many' ? [value] : value });
    } else if (pick === 'today') {
      picks.push({ label: 'Today', value: ctx.todayKey });
    } else if (pick === 'tomorrow') {
      picks.push({ label: 'Tomorrow', value: addDaysToKey(ctx.todayKey, 1) });
    }
  }
  return picks;
}

/** The rules' quick picks first, then the field's own; one per label, at most three. */
function quickPicksOf(field: WriteFormField, input: FormBlockInput): Array<{ label: string; value: FormValue }> {
  const out: Array<{ label: string; value: FormValue }> = [];
  const seen = new Set<string>();
  for (const pick of [...(input.quickPicks[field.key] ?? []), ...ownPicks(field, input.ctx)]) {
    const label = clip(pick.label, 80);
    const value = formValueOf(pick.value);
    if (!label || value === undefined || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, value });
    if (out.length >= FORM_CAPS.quickPicks) break;
  }
  return out;
}

function choiceOf(choice: EntityChoice): EntityChoice | null {
  if (!choice || typeof choice.id !== 'string' || !HEX_ID.test(choice.id)) return null;
  return {
    module: clip(choice.module, 120), id: choice.id, ...(choice.number ? { number: clip(choice.number, 80) } : {}),
    label: clip(choice.label, 200), source: choice.source, ...(choice.detail ? { detail: clip(choice.detail, 200) } : {}),
  };
}

function targetOf(target: EntityRef & { href?: AppLink }): EntityRef & { href?: AppLink } {
  return {
    module: clip(target.module, 120), id: clip(target.id, 64), ...(target.number ? { number: clip(target.number, 80) } : {}),
    label: clip(target.label, 200), source: target.source, ...(target.href ? { href: target.href } : {}),
  };
}

function formField(field: WriteFormField, input: FormBlockInput, masked: boolean, keys: ReadonlySet<string>): FormField {
  const { ctx } = input;
  const hidden = hiddenModuleOf(field, ctx);
  // A field the record a create is made from fills (an invoice's customer) is shown, never changed here.
  const readOnly = hidden !== null || !!input.readOnlyKeys?.includes(field.key);
  // A hint from this request (a name that matched several, a note on a date, where a fixed value came from) comes first.
  const help = input.hints[field.key]
    ?? (hidden !== null ? refHiddenText(hidden) : masked ? MASKED_FIELD_HELP
      : field.help ?? (field.kind === 'datetime' ? `Times are in ${ctx.timezone}.` : undefined));
  const options = selectOptions(field, input);
  const ref = refSpecOf(field, ctx, keys);
  const candidates = readOnly ? [] : (input.candidates[field.key] ?? []).map(choiceOf)
    .filter((c): c is EntityChoice => c !== null).slice(0, FORM_CAPS.candidates);
  const quickPicks = readOnly ? [] : quickPicksOf(field, input);
  return {
    key: field.key,
    label: clip(field.label, 120),
    ...(field.group ? { group: clip(field.group, 80) } : {}),
    ...(help ? { help: clip(help, 300) } : {}),
    input: INPUTS[field.kind],
    required: field.required,
    ...(readOnly ? { readOnly: true } : {}),
    ...(masked ? { masked: true } : {}),
    ...boundsOf(field),
    ...maxLengthOf(field),
    ...(field.kind === 'money' ? { currency: currencyOf(input) } : {}),
    ...(field.kind === 'datetime' ? { tz: clip(ctx.timezone, 64) } : {}),
    ...(options ? { options } : {}),
    ...(ref ? { ref } : {}),
    ...(candidates.length ? { candidates } : {}),
    ...(quickPicks.length ? { quickPicks } : {}),
    // A field nobody filled yet is the person's to type (create) or the record's own (update).
    origin: input.origins[field.key] ?? (input.op === 'update' ? 'source' : 'user'),
  };
}

/** "Continue in full form" (work order creates, L27): the screen's list page
 * and the server-built prefill, only the screen's own keys. */
function fullFormOf(input: FormBlockInput): FullFormAction | undefined {
  const spec = input.wf.cap.fullForm;
  if (input.op !== 'create' || !spec || !input.fullFormPrefill) return undefined;
  const keys = new Set(spec.keys);
  const prefill: Record<string, PrefillValue> = {};
  for (const [key, value] of Object.entries(input.fullFormPrefill)) {
    if (!keys.has(key) || key === 'id' || value === undefined) continue;
    if (Object.keys(prefill).length >= FORM_CAPS.prefillKeys) break;
    prefill[key] = Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, FORM_CAPS.multi).map((v) => v.slice(0, 120))
      : typeof value === 'string' ? value.slice(0, FORM_CAPS.textarea) : value;
  }
  return { kind: 'full_form', label: FULL_FORM_LABEL, href: { path: spec.list, exact: false }, prefill };
}

/** The guided form as the chat draws it (spec B10): one field per form
 * field in the WriteCap's order (custom fields last, under "More fields"),
 * the values so far, an error per field ("Required." for each missing one),
 * and ready only with no error, no missing value and no form error. An error
 * for a key the form doesn't show becomes a form error, so nothing keeps
 * Review from being pressed unseen; a document's line errors stay on its
 * lines (they count for ready too). Validated (FormBlockSchema plus links);
 * throws FormComposeError when it can't be. */
export function composeFormBlock(input: FormBlockInput): FormBlock {
  const { cap, op } = input;
  const singular = cap.labels.singular.toLowerCase();
  const fields = input.fields.slice(0, FORM_CAPS.fields);
  const keys = new Set(fields.map((f) => f.key));
  const masked = new Set(input.masked);
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    const value = formValueOf(input.form[field.key]);
    if (value !== undefined) values[field.key] = value;
  }
  const labelOf = (key: string) => input.fields.find((f) => f.key === key)?.label ?? fieldLabel(key, cap, {});
  const errors: Record<string, string> = {};
  const elsewhere: string[] = [];
  for (const [key, message] of Object.entries(input.fieldErrors)) {
    if (keys.has(key) || (input.lines && isLineErrorKey(key))) errors[key] = clip(message, 300);
    else elsewhere.push(`${labelOf(key)}: ${message}`);
  }
  for (const key of input.missing) {
    if (!keys.has(key)) elsewhere.push(`${labelOf(key)}: ${REQUIRED_TEXT}`);
    else if (!errors[key]) errors[key] = REQUIRED_TEXT;
  }
  const named = input.target?.number ?? input.target?.label;
  const fullForm = fullFormOf(input);
  const created = input.fromNumber ? `Create ${singular} from ${input.fromNumber}` : `Create ${singular}`;
  const block: FormBlock = {
    id: clip(`form-${input.operationId}`, 80),
    type: 'form',
    title: clip(op === 'create' ? created : `Change ${singular}${named ? ` ${named}` : ''}`, 200),
    source: sourceRefFor(cap, input.scopeKind),
    operation: { id: input.operationId, revision: input.revision, expiresAt: input.expiresAt.toISOString() },
    module: cap.key,
    op,
    ...(input.target ? { target: targetOf(input.target) } : {}),
    timezone: clip(input.ctx.timezone, 64),
    fields: fields.map((field) => formField(field, input, masked.has(field.key), keys)),
    values,
    errors,
    formErrors: [...input.formErrors, ...elsewhere].slice(0, FORM_CAPS.formErrors).map((e) => clip(e, 300)),
    warnings: input.warnings.slice(0, FORM_CAPS.warnings).map((w) => clip(w, 300)),
    notTaken: input.notTaken.slice(0, FORM_CAPS.notTaken).map((w) => clip(w, 120)),
    sideEffects: input.sideEffects.slice(0, FORM_CAPS.sideEffects).map((s) => ({ kind: s.kind, text: clip(s.text, 300) })),
    // A document's lines and its totals as the lifecycle built them (null: not worked out yet).
    ...(input.lines ? { lines: input.lines } : {}),
    ...(input.totals !== undefined ? { totals: input.totals } : {}),
    ready: Object.keys(input.fieldErrors).length === 0 && input.missing.length === 0 && input.formErrors.length === 0,
    ...(fullForm ? { fullForm } : {}),
  };
  const parsed = FormBlockSchema.safeParse(block);
  const badLink = parsed.success ? collectLinks(parsed.data).find((p) => !isKnownAppLink(p)) : undefined;
  if (!parsed.success || badLink !== undefined) {
    logger.error('CRM assist: form could not be built; nothing shown', {
      module: cap.key, op, issue: parsed.success ? `link ${badLink}` : parsed.error.issues[0]?.path.join('.'),
    });
    throw new FormComposeError(`The ${singular} form couldn't be built.`);
  }
  return parsed.data;
}

/* ── Review ────────────────────────────────────────────────────────────── */

/** The stage labels, colours and tones of the module's pipeline, from the
 * stages the form context read (peekStages), as loadStatusInfo words them. */
function statusInfoOf(cap: ModuleCap, ctx: FormContext): StatusInfo | null {
  const stage = cap.stage;
  if (!stage || !('pipeline' in stage)) return null;
  const stages = ctx.stageOptions[stage.field];
  if (!stages) return null;
  const options = new Map<string, StatusOption>();
  for (const s of stages) {
    const cancelled = s.terminal && /cancel|lost|reject|disqualif/i.test(s.key);
    options.set(s.key, { label: s.label, ...(s.color ? { color: s.color } : {}), tone: !s.terminal ? 'open' : cancelled ? 'cancelled' : 'done' });
  }
  return { field: stage.field, options };
}

/** The review's read context, from the form context (loaded with the same
 * rules reviewReadContext uses), so the review is built without a read. */
function readContextOf(cap: ModuleCap, ctx: FormContext): ReadContext {
  return { piiVisible: ctx.piiVisible, currency: ctx.branchCurrency, status: statusInfoOf(cap, ctx), allowedKeys: new Set(readFieldKeysFor(cap.key)) };
}

function refsOf(value: StoredRefValue | undefined): StoredRef[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function isEmptyWrite(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** A picked record as a cell: its name (never an id) and number. */
function refCell(ref: StoredRef): Cell {
  const label = scrubIds(ref.label) || ref.number || (getModuleCap(ref.module)?.labels.singular ?? 'Record');
  return { t: 'ref', label: clip(label, 200), ...(ref.number ? { number: clip(ref.number, 80) } : {}) };
}

/** A value's cell after the change: picked records by their names, staff as
 * their names joined, a date-time in the tenant's zone, anything else as the
 * legacy review shows it (valueCell). */
function afterCell(field: WriteFormField | undefined, key: string, after: unknown, input: WorkflowReviewInput, read: ReadContext): Cell {
  const empty: Cell = { t: 'text', v: null };
  if (field && (field.kind === 'ref' || field.kind === 'owner_user' || field.kind === 'ref_many')) {
    const refs = refsOf(input.refs[field.key]);
    if (isEmptyWrite(after)) return empty;
    if (field.kind !== 'ref_many' && refs[0]) return refCell(refs[0]);
    const names = refs.map((r) => scrubIds(r.label)).filter(Boolean).join(', ');
    if (field.kind === 'ref_many' && names) return { t: 'text', v: clip(names, 300) };
  }
  if (field?.kind === 'datetime') {
    const d = after instanceof Date ? after : typeof after === 'string' && after ? new Date(after) : null;
    return d && !Number.isNaN(d.getTime()) ? { t: 'datetime', v: d.toISOString(), tz: clip(input.ctx.timezone, 64) } : empty;
  }
  return valueCell(input.cap, input.def, key, after, read, input.ctx.timezone, false);
}

/** A custom date-time's cell, before or after. The screens store the
 * tenant's wall time with no zone, as the chat writes it (customDateTimeOf):
 * it is shown as the instant that wall time names in the tenant's zone, so
 * the card shows the same wall time with the zone, never one read in the
 * server's zone. A bare day is a day; a Date, or text that names its zone,
 * the instant it is. undefined for anything else: the legacy review shows it. */
function customDatetimeCell(value: unknown, timezone: string): Cell | undefined {
  const tz = clip(timezone, 64);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : { t: 'datetime', v: value.toISOString(), tz };
  const read = typeof value === 'string' ? customDateTimeOf(value) : null;
  if (!read) return undefined;
  if ('at' in read) return { t: 'datetime', v: read.at.toISOString(), tz };
  if (read.wall.time === null) return { t: 'date', v: read.wall.date };
  const [year, month, day] = read.wall.date.split('-').map(Number);
  const [hour, minute] = read.wall.time.split(':').map(Number);
  return { t: 'datetime', v: wallTimeToUtc({ year, month, day, hour, minute }, timezone).at.toISOString(), tz };
}

/** One row per changed field: the related keys as one row, labels from the form. A document's lines are its lines
 * (ReviewBlock.lines), never rows. */
function reviewRows(input: WorkflowReviewInput, read: ReadContext): ReviewBlock['changes'] {
  const { cap, def, ctx, op, wf } = input;
  const rows: ReviewBlock['changes'] = [];
  const related = wf.cap.fields.find((f) => f.kind === 'related');
  let relatedShown = false;
  for (const change of input.changes) {
    if (LINE_KEYS.has(change.key)) continue;
    if (related && RELATED_KEYS.has(change.key)) {
      if (relatedShown) continue;
      relatedShown = true;
      const ref = refsOf(input.refs[related.key])[0];
      const before = op === 'create' ? undefined : textOf(input.shown.relatedLabel, 200) ?? textOf(input.shown.relatedId, 200);
      rows.push({
        key: clip(related.key, 80), label: clip(related.label, 120),
        before: op === 'create' ? null : { t: 'text', v: before ?? null },
        after: ref ? refCell(ref) : { t: 'text', v: null },
      });
      continue;
    }
    const field = wf.cap.fields.find((f) => f.key === change.key);
    const custom = field ? undefined : ctx.customFields.find((c) => c.key === change.key);
    const label = field?.label ?? custom?.label ?? fieldLabel(change.key, cap, {});
    const datetimeCell = (value: unknown) => (custom?.type === 'datetime' ? customDatetimeCell(value, ctx.timezone) : undefined);
    const before = op === 'create' ? undefined : shownValue(input.shown, change.key);
    rows.push({
      key: clip(change.key, 80),
      label: clip(label, 120),
      before: op === 'create' ? null : datetimeCell(before) ?? valueCell(cap, def, change.key, before, read, ctx.timezone, true),
      after: datetimeCell(change.after) ?? afterCell(field, change.key, change.after, input, read),
    });
  }
  return rows.slice(0, 60);
}

/** The review of a guided create, update or delete, as the legacy review
 * shows one (stageOperation), with the picked records by name, staff as
 * their names, date-times in the tenant's zone, and `editable` (create and
 * update go back to the form with Edit). Validated (ReviewBlockSchema plus
 * links); throws FormComposeError when it can't be. */
export function composeWorkflowReview(input: WorkflowReviewInput): ReviewBlock {
  const { cap, op } = input;
  const singular = cap.labels.singular.toLowerCase();
  const named = input.target?.number ?? input.target?.label;
  const read = readContextOf(cap, input.ctx);
  const block: ReviewBlock = {
    id: clip(`review-${input.operationId}`, 80),
    type: 'review',
    title: clip(`${IMPERATIVE[op]} ${singular}${named ? ` ${named}` : ''}`, 200),
    source: sourceRefFor(cap, input.scopeKind),
    operation: {
      id: input.operationId, revision: input.revision, payloadHash: input.payloadHash, digest: digestOf(input.payloadHash),
      expiresAt: input.expiresAt.toISOString(),
    },
    module: cap.key,
    op,
    ...(input.target ? { target: targetOf(input.target) } : {}),
    changes: reviewRows(input, read),
    // A document's lines and its totals, as the stack checked them.
    ...(input.lines?.length ? { lines: input.lines } : {}),
    ...(input.totals ? { totals: input.totals } : {}),
    warnings: input.warnings.slice(0, 10).map((w) => clip(w, 300)),
    sideEffects: input.sideEffects.slice(0, 20).map((s) => ({ kind: s.kind, text: clip(s.text, 300) })),
    status: 'pending',
    editable: input.editable,
  };
  const parsed = ReviewBlockSchema.safeParse(block);
  const badLink = parsed.success ? collectLinks(parsed.data).find((p) => !isKnownAppLink(p)) : undefined;
  if (!parsed.success || badLink !== undefined) {
    logger.error('CRM assist: workflow review could not be built; nothing shown', {
      module: cap.key, op, issue: parsed.success ? `link ${badLink}` : parsed.error.issues[0]?.path.join('.'),
    });
    throw new FormComposeError(`The review of this ${singular} couldn't be built.`);
  }
  return parsed.data;
}

/* ── Which record ──────────────────────────────────────────────────────── */

/** Each match's choice label, no two alike: "<name> (<number>)"; equal ones
 * take their detail when that tells them apart, then their place among them,
 * newest first. A label taking its detail drops it as a separate line. */
function choiceLabels(matches: readonly EntityMatch[]): Array<{ label: string; detail?: string }> {
  const cut = (text: string) => clip(scrubIds(text.replace(/\s+/g, ' ').trim()), MAX_CHOICE_LABEL);
  const base = matches.map((m) => ({
    label: cut(m.number && m.number !== m.label ? `${m.label} (${m.number})` : m.label) || 'This record',
    detail: m.detail ? clip(scrubIds(m.detail), 200) : '',
  }));
  const repeated = (labels: readonly string[]) => {
    const counts = new Map<string, number>();
    labels.forEach((l) => counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) ?? 0) + 1));
    return new Set([...counts].filter(([, n]) => n > 1).map(([l]) => l));
  };
  const alike = repeated(base.map((b) => b.label));
  const withDetail = base.map((b) => (b.detail ? cut(`${b.label} · ${b.detail}`) : b.label));
  const told = base.map((b, i) => {
    const key = b.label.toLowerCase();
    if (!alike.has(key) || !b.detail) return b;
    const group = base.flatMap((o, j) => (o.label.toLowerCase() === key ? [withDetail[j].toLowerCase()] : []));
    return new Set(group).size < group.length ? b : { label: withDetail[i], detail: '' };
  });
  const still = repeated(told.map((t) => t.label));
  const seen = new Map<string, number>();
  return told.map((t) => {
    const key = t.label.toLowerCase();
    let label = t.label;
    if (still.has(key)) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const order = ` · ${ORDINALS[n - 1] ?? `Number ${n} by newest`}`;
      label = `${clip(t.label, MAX_CHOICE_LABEL - order.length)}${order}`;
    }
    return { label, ...(t.detail ? { detail: t.detail } : {}) };
  });
}

/** A target that names several records (or none on screen): a choice each,
 * each starting the same write for that record by its _id. */
export function composeTargetChoices(input: { cap: ModuleCap; intent: WriteIntent; matches: EntityMatch[]; more: boolean;
  reason: 'ambiguous_entity' | 'duplicate_number' | 'no_focus'; text?: string }): ComposedAnswer {
  const shown = input.matches.filter((m) => HEX_ID.test(m.id)).slice(0, 10);
  const labels = choiceLabels(shown);
  const options: ClarifyOption[] = shown.map((m, i) => ({
    label: labels[i].label, ...(labels[i].detail ? { detail: labels[i].detail } : {}),
    run: { intent: { ...input.intent, target: { ref: m.id } } },
  }));
  const question = `Which ${input.cap.labels.singular.toLowerCase()} do you mean?${input.more ? " Type more of the name if it isn't here." : ''}`;
  const block: ClarifyBlock = { id: 'b1', type: 'clarify', question: clip(question, 300), reason: input.reason, options };
  return { blocks: [block], summary: 'Offered choices.', dataRead: false };
}

/* ── Notices and answers ───────────────────────────────────────────────── */

/** A workflow notice (codes in B20); the text is server-written. */
export function workflowNotice(code: string, text: string, tone: NoticeBlock['tone'] = 'info', href?: AppLink): NoticeBlock {
  return {
    id: clip(`notice-${code}`, 80), type: 'notice', tone, code: clip(code, 60), text: clip(scrubIds(text), 1000), ...(href ? { href } : {}),
  };
}

/** The notices after a block, ids made unique within the answer. */
function noticesAfter(blockId: string, notices: readonly NoticeBlock[]): NoticeBlock[] {
  return notices.slice(0, FORM_CAPS.notices).map((n, i) => ({ ...n, id: clip(`${blockId}-n${i + 1}`, 80) }));
}

/** The history summary of a form answer (B20: never ends in "?"). */
export function formSummary(block: FormBlock): string {
  const singular = singularOf(block.module);
  if (block.operation.revision > 1) return summaryOf(`Updated the open ${singular} form.`);
  if (block.op === 'create') return summaryOf(`Opened a form to create ${article(singular)} ${singular}.`);
  const named = block.target?.number ?? block.target?.label;
  return summaryOf(`Opened a form to change ${singular}${named ? ` ${named}` : ''}.`);
}

function reviewSummary(block: ReviewBlock): string {
  const singular = singularOf(block.module);
  const named = block.target?.number ?? block.target?.label;
  return summaryOf(block.op === 'create' || !named
    ? `Showed the review to ${REVIEW_VERB[block.op]} ${article(singular)} ${singular}.`
    : `Showed the review to ${REVIEW_VERB[block.op]} ${singular} ${named}.`);
}

function resultSummary(block: ResultBlock): string {
  return block.status === 'cancelled' ? 'Cancelled the open form.' : summaryOf(block.message);
}

/** The composed answer for a workflow reply (spec B10): a form or a review
 * with its notices (the session's open operation becomes it), a result (the
 * open operation is cleared), a notice, a refusal as a notice, or a clarify
 * as composed; null for not_workflow. */
export function composeWorkflowAnswer(reply: WorkflowReply):
  { composed: ComposedAnswer; path: 'workflow' | 'clarify'; confirmation?: OperationConfirmation } | null {
  switch (reply.kind) {
    case 'form':
      return {
        composed: {
          blocks: [reply.block, ...noticesAfter(reply.block.id, reply.notices)], summary: formSummary(reply.block), dataRead: true,
          operationId: reply.operationId,
        },
        path: 'workflow',
      };
    case 'review':
      return {
        composed: {
          blocks: [reply.block, ...noticesAfter(reply.block.id, reply.notices)], summary: reviewSummary(reply.block), dataRead: true,
          operationId: reply.operationId, confirmation: reply.confirmation,
        },
        path: 'workflow',
        confirmation: reply.confirmation,
      };
    case 'result':
      return { composed: { blocks: [reply.block], summary: resultSummary(reply.block), dataRead: true, operationId: null }, path: 'workflow' };
    case 'notice':
      return { composed: { blocks: [reply.notice], summary: summaryOf(reply.notice.text), dataRead: false }, path: 'workflow' };
    case 'clarify':
      return { composed: reply.composed, path: 'clarify' };
    case 'refused':
      return {
        composed: {
          blocks: [workflowNotice(REFUSED_CODES[reply.http] ?? 'refused', reply.message, 'warning')], summary: summaryOf(reply.message), dataRead: false,
        },
        path: 'workflow',
      };
    default:
      return null;
  }
}
