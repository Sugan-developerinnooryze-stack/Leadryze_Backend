import type { CrmWriteModuleDef } from '../../internal/crm-write.module-map';
import { applyPIIProtection } from '../../internal/crm-read.service';
import { isRecordLockModule, resolveAssistantAuditActor } from '../../internal/crm-gateway.helpers';
import { getLockStatus } from '../../native-crm/record-lock/record-lock.service';
import type { RefInput, WriteIntent, WriteValue } from '../contracts/plan';
import type { OperationOutcome } from '../contracts/api';
import { listLinkFor, recordLinkFor } from '../contracts/routes';
import { FORM_CAPS } from '../contracts/views';
import type {
  AppLink, EntityChoice, EntityRef, FormBlock, FormLines, FormRefValue, FormValue, NoticeBlock, OperationConfirmation, ResultBlock, ReviewBlock,
} from '../contracts/views';
import { isAdminIdentity } from '../gates';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteFormField } from '../registry/types';
import { gateRelated } from '../query/relations';
import type { RelatedGate, RelatedGateResult } from '../query/relations';
import { MAX_ENTITY_MATCHES, recentEntities, resolveEntity } from '../query/resolve-entity';
import type { EntityMatch } from '../query/resolve-entity';
import { businessNumberOf } from '../query/validate';
import { titleOf } from '../views/compose';
import { composeFormBlock, composeTargetChoices, composeWorkflowReview, workflowNotice } from '../views/compose-form';
import { scrubIds } from '../views/fallback-text';
import { textRefField } from '../writes/simple.workflow';
import { workflowModuleFor } from '../writes/write-caps';
import type {
  FieldNote, FillFormSpec, FormContext, FormOrigin, LineEdit, PrefillSource, RefDeps, RefResolution, SealedLine, SourceSnapshot, SourceStart,
  StackResult, StartInput, StartSource, StoredRef, StoredRefValue, WorkflowCaller, WorkflowModule, WorkflowReply,
} from '../writes/workflow-types';
import { CrmAssistOperation, DRAFT_TTL_MS, MAX_DRAFT_REVISIONS, PURGE_AFTER_MS, STAGED_TTL_MS, newOperationId } from './operation.model';
import type { CrmAssistOperationDoc, OperationOp, TargetVersion } from './operation.model';
import { auditOperationStep } from './audit';
import { createChanges, fieldKeysOf, reduceToChanges } from './diff';
import type { FieldChange } from './diff';
import { expireIfDue, isStuckExecuting, markUnknown, transitionOperation } from './expiry-sweep';
import {
  FORM_BRANCH_MESSAGE, NOTHING_CHANGES_MESSAGE, captureVersion, checkAccess, clip, computePayloadHash, findOwned, hashVersion, lockedMessage,
  notFoundMessage, outcomeOf, outcomeWithoutDocument, plainOutcome, supersedeSessionOperations, textOf, toPlain, writableModule,
} from './operation.service';
import { isWorkflowSealed, seal, unseal } from './sealed';
import type { VersionToken, WorkflowSealed } from './sealed';
import {
  addressPrefill, applyAddressPrefill, createDefaults, fieldsFor, formSpecOf, loadFormContext, recordToForm, writeValueToForm,
} from './prefill';
import { readStoredRefs, resolveFieldRef, resolveFieldRefs } from './references';
import { runFormStack } from './form-stack';
import { workflowSideEffects } from './side-effects';
import { LINE_WRITE_KEYS, applyLineEdits, lineRowsOf, resolveIntentLines } from './document-lines';

/* The guided forms' lifecycle (Increment 6, B-FLOW; spec B2 and B12):
 *
 *   start    -> a write intent (the grammar's, the planner's or a choice's)
 *               becomes a draft: the module's switch and the caller's
 *               permission, the record an update names (read as the write
 *               itself reads it, unlocked and versioned), the form's
 *               defaults or the record's values (PII masked, L10), what the
 *               message asked for, then the validation stack. The session's
 *               open operation is superseded (L2). A delete goes straight to
 *               its review (L10). A start that can't finish before its
 *               deadline creates nothing.
 *   validate / fill
 *            -> the browser's values (origin user) or a typed answer's
 *               (origin suggested) merged into the draft, picked records
 *               read again under their module's scope, the stack again,
 *               revision + 1 and the expiry slid (L12).
 *   review   -> the stack in review mode, an update reduced to what really
 *               changes, the version captured again, the hash: staged.
 *   edit     -> staged back to draft; the reviewed hash can't be confirmed.
 *   cancel / status.
 *
 * Every step checks the owner (tenant, user and chat session); validate,
 * fill, review and edit also the branch. Every mutation is a compare-and-set
 * on status, revision and expiry, so the browser and the chat can't overwrite
 * each other: the one that loses gets the latest block. Nothing but the
 * operation document is written before Confirm (operation.service.ts), and
 * only start, review, edit and cancel write an audit entry (validate and
 * fill don't, L12). Values live only in the sealed payload and are never
 * logged.
 *
 * Increment 7 (spec B5.6): a document create (an invoice, a quotation) also
 * holds its lines beside the form (sealed `lines`): typed lines are priced
 * at start, the browser's line list is applied on validate, and review shows
 * the lines and the totals the stack worked out. A create made from another
 * record (an invoice from a work order) starts from the module's own source
 * read (sealed `source.from`): its values and lines, its fixed fields
 * read-only. An operation the module refuses (an invoice or quotation
 * delete) answers its notice before anything is checked or read. */

const FORM_STALE = 'This form changed in the chat. Here is the latest version.';
const FORM_REVIEWED = 'This form was sent for review. Use the review card, or press Edit there to change it.';
const TOO_MANY_CHANGES = 'This form has changed too many times. Cancel it and start again.';
const RECORD_CHANGED = 'This record changed since you opened the form. Its values were refreshed; check them and review again.';
const FORM_TIMEOUT = "I couldn't open the form in time. Try again.";
const CANT_CANCEL_NOW = "This change is already being applied and can't be cancelled now. Check again in a moment.";
const TARGET_GONE = 'This record no longer exists, or you can no longer see it.';
const NAME_OWNED_CONTACT = "This contact is owned only by name, so it can't be changed from the assistant. Open it on its page.";
const PICK_HERE = 'Pick it here.';
const PICK_RECORD = 'Pick a record from the list.';
const REF_GONE = 'This record is gone or no longer visible to you. Pick another.';
const SITE_OTHER_CUSTOMER = 'This site belongs to another customer.';
const PICK_CUSTOMER_FIRST = 'Pick a customer first.';
const OWNER_NOT_USER = 'Pick a CRM user as the owner.';
const ADD_TIME = 'Add a time.';
const AM_PM = 'AM or PM?';
const WHICH_DAY = 'Which day?';
const MIDNIGHT = "Midnight can't be saved as a time. Pick another time.";
/** A date field given a time keeps only the day (not a B20 text; a task's due date says so in its own help). */
const TIME_NOT_SAVED = 'Only the date is saved.';
const UNKNOWN_FIELD = 'This form has no such field.';
const NOT_EDITABLE = "This change can't be edited. Cancel it and ask again.";
const NO_LONGER_WRITABLE = "This change can't be made from the assistant any more.";
/* A document's lines and the record a create is made from (Increment 7, spec B12). */
const LINES_FROM_CATALOG = 'Prices come from your service catalog.';
const LINES_HIDDEN = "You can't look up services here.";
const LINES_NONE = 'This form has no lines.';
const LINES_FIXED = "These lines come from another record and can't be changed here.";
const FIXED_FIELD = "This value comes from another record and can't be changed here.";
const linesFromSource = (number: string) => `Lines and prices from ${number}.`;
const linesFromSourceNotTaken = (number: string) => `Lines come from ${number}, so the lines in your message weren't added.`;

const ambiguousText = (text: string) => `Several match "${clip(text, 100)}". Pick one.`;
const refNotFoundText = (singular: string, text: string) => `No ${singular} you can see is named "${clip(text, 100)}". Pick one here.`;
const refHiddenText = (plural: string) => `You can't look up ${plural} here.`;
const staffNotInTeamText = (team: string) => `This staff member isn't in team ${team}.`;

const IMPERATIVE: Record<OperationOp, string> = { create: 'Create', update: 'Update', delete: 'Delete' };

/** A start creates nothing this close to its deadline (spec B12.1). */
const CREATE_MARGIN_MS = 300;
/** A start stops looking up the records its message names this close to its deadline: the rest are picked on the form. */
const REF_MARGIN_MS = 600;
/** How long a typed answer's records may take to look up (a fill has no deadline of its own). */
const FILL_REF_BUDGET_MS = 2000;
/** "This task" with no task on screen: the newest ones to choose from. */
const RECENT_CHOICES = 5;
/** The field kinds a record is picked for. */
const REF_KINDS: ReadonlySet<WriteFormField['kind']> = new Set(['ref', 'ref_many', 'related', 'owner_user']);
const HEX_ID = /^[a-f0-9]{24}$/i;

/** The draft's form as one step changes it (the sealed payload's form parts), a document's lines (Increment 7), and
 * the record a create is made from (sealed source.from, which no step changes). */
interface DraftState {
  form: Record<string, FormValue>; origins: Record<string, FormOrigin>; masked: string[];
  refs: Record<string, StoredRefValue>; candidates: Record<string, EntityChoice[]>; hints: Record<string, string>;
  provenance: Record<string, PrefillSource>;
  lines: SealedLine[];
  from?: SourceSnapshot;
}

/** What every step of an open form needs: the module's write, the caller's form context and the form's fields. */
interface Flow {
  wf: WorkflowModule; def: CrmWriteModuleDef; cap: ModuleCap; op: 'create' | 'update';
  ctx: FormContext; fields: WriteFormField[]; gate: RelatedGate;
}

/** The record an update or delete names, as start found it. */
interface FoundTarget {
  id: string;
  /** As stored (for the rules), and as this caller may see it (for the form and the review). */
  raw: Record<string, unknown>; shown: Record<string, unknown>;
  captured: { version: TargetVersion; token?: VersionToken };
  number?: string; label: string;
}

/** One request's own errors and warnings, shown with the stack's. */
interface Extra { fieldErrors?: Record<string, string>; formErrors?: string[]; warnings?: string[] }

type FormTarget = EntityRef & { href?: AppLink };
type Opened = { ok: true; doc: CrmAssistOperationDoc; sealed: WorkflowSealed; flow: Flow } | { ok: false; reply: WorkflowReply };

const lower = (s: string) => s.toLowerCase();
const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const purgeAfter = (at: Date) => new Date(at.getTime() + PURGE_AFTER_MS);

function singularOf(module: string): string {
  return module === 'user' ? 'user' : lower(getModuleCap(module)?.labels.singular ?? 'record');
}

function pluralOf(module: string): string {
  return module === 'user' ? 'users' : lower(getModuleCap(module)?.labels.plural ?? 'records');
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function isFormRef(value: unknown): value is FormRefValue {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { ref?: unknown }).ref === 'string';
}

function refList(value: StoredRefValue | undefined): StoredRef[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function singleRef(value: StoredRefValue | undefined): StoredRef | undefined {
  return value && !Array.isArray(value) ? value : undefined;
}

/** A picked record as the form holds it (a related field also names its module). */
function formRefOf(field: WriteFormField, ref: StoredRef): FormRefValue {
  return { ref: ref.id, label: clip(ref.label, 200), ...(field.kind === 'related' ? { module: ref.module } : {}) };
}

/** A value compared for "did it change": a picked record by its id, any empty value alike. */
function valueKey(value: unknown): string {
  const norm = (v: unknown): unknown => (isEmptyValue(v) ? null : isFormRef(v) ? `ref:${v.ref.toLowerCase()}` : Array.isArray(v) ? v.map(norm) : v);
  return JSON.stringify(norm(value));
}

function valueKeys(fields: readonly WriteFormField[], state: DraftState): Map<string, string> {
  return new Map(fields.map((field) => [field.key, valueKey(state.form[field.key])]));
}

function changedSince(fields: readonly WriteFormField[], state: DraftState, before: Map<string, string>): Set<string> {
  return new Set(fields.filter((field) => before.get(field.key) !== valueKey(state.form[field.key])).map((field) => field.key));
}

/* ── The draft's state ─────────────────────────────────────────────────── */

function stateOf(sealed: WorkflowSealed): DraftState {
  return {
    form: { ...sealed.form }, origins: { ...sealed.origins }, masked: [...sealed.masked], refs: { ...sealed.refs },
    candidates: { ...sealed.candidates }, hints: { ...sealed.hints }, provenance: { ...sealed.provenance },
    lines: [...(sealed.lines ?? [])], ...(sealed.source.from ? { from: sealed.source.from } : {}),
  };
}

function emptyState(): DraftState {
  return { form: {}, origins: {}, masked: [], refs: {}, candidates: {}, hints: {}, provenance: {}, lines: [] };
}

/** Words as the person typed them, one space between. */
function wordsOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A record without the keys given (a message's or a typed answer's values and records for the fields a source fixes). */
function withoutKeys<T>(record: Record<string, T> | undefined, keys: ReadonlySet<string>): Record<string, T> | undefined {
  if (!record || !keys.size) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

/** A value given to a field (typed, picked or read from words): its default, hint and choices go with the old value. */
function setField(state: DraftState, key: string, value: FormValue, origin: FormOrigin): void {
  state.form[key] = value;
  state.origins[key] = origin;
  delete state.provenance[key];
  delete state.hints[key];
  delete state.candidates[key];
}

function clearField(field: WriteFormField, state: DraftState, origin: FormOrigin): void {
  setField(state, field.key, field.kind === 'ref_many' ? [] : null, origin);
  delete state.refs[field.key];
}

function sourceOf(startedBy: StartSource, token?: VersionToken, targetLabel?: string): WorkflowSealed['source'] {
  return { origin: 'workflow', startedBy, ...(token ? { versionToken: token } : {}), ...(targetLabel ? { targetLabel } : {}) };
}

/** A draft's sealed payload after a change: its form and the write data last computed (a draft has no review), and a
 * document's lines as the stack last checked them (once the payload has lines, or a row exists). */
function draftSealed(sealed: WorkflowSealed, state: DraftState, stack: StackResult, source: WorkflowSealed['source'] = sealed.source): WorkflowSealed {
  return {
    v: 2, form: state.form, origins: state.origins, masked: state.masked, refs: stack.refs, candidates: state.candidates,
    hints: state.hints, provenance: state.provenance, notTaken: sealed.notTaken, values: stack.values,
    ...(sealed.lines !== undefined || state.lines.length ? { lines: stack.lines ?? state.lines } : {}),
    source,
  };
}

/** A draft's source rebuilt (review, refresh) keeps the record a create is made from. */
function keptFrom(source: WorkflowSealed['source'], sealed: WorkflowSealed): WorkflowSealed['source'] {
  return { ...source, ...(sealed.source.from ? { from: sealed.source.from } : {}) };
}

/* ── Replies ───────────────────────────────────────────────────────────── */

function refused(http: 400 | 403 | 404 | 409, message: string, block?: FormBlock | ReviewBlock | ResultBlock): WorkflowReply {
  return { kind: 'refused', http, message, ...(block ? { block } : {}) };
}

function noticeReply(code: string, text: string, tone: NoticeBlock['tone'] = 'info', href?: AppLink): WorkflowReply {
  return { kind: 'notice', notice: workflowNotice(code, text, tone, href) };
}

/** An outcome's result card. An operation the caller can't see gets one that names no module (B2: never "not yours"). */
function resultReply(operationId: string, outcome: OperationOutcome, doc?: Pick<CrmAssistOperationDoc, '_id' | 'module' | 'op'>): WorkflowReply {
  let block = outcome.result;
  if (!block && outcome.status !== 'applied' && outcome.status !== 'pending') {
    block = plainOutcome(doc ?? { _id: operationId, module: '', op: 'update' }, outcome.status, outcome.message, outcome.repeat === true).result;
  }
  if (!block) throw new Error('CRM assist: the result card could not be built');
  return { kind: 'result', operationId, block, notices: [] };
}

/** No operation this caller owns: applied (from its audit entry) or expired, as a confirm answers it. */
async function missingReply(operationId: string, caller: WorkflowCaller): Promise<WorkflowReply> {
  return resultReply(operationId, await outcomeWithoutDocument(caller.identity.tenantId, caller.identity.userId, operationId));
}

/** The reply for an operation that is no longer open: past its expiry (expired now), being applied (stuck: unknown),
 * or final. null while it is an open draft or review. */
async function closedReply(doc: CrmAssistOperationDoc, now: Date): Promise<WorkflowReply | null> {
  if (doc.status === 'draft' || doc.status === 'staged') {
    if (new Date(doc.expiresAt).getTime() > now.getTime()) return null;
    const expired = await expireIfDue(doc._id, now);
    return resultReply(doc._id, await outcomeOf(expired ?? { ...doc, status: 'expired' }, false), doc);
  }
  if (doc.status === 'executing') {
    if (isStuckExecuting(doc, now)) {
      const unknown = await markUnknown(doc._id, now);
      return resultReply(doc._id, await outcomeOf(unknown ?? doc, true), doc);
    }
    return resultReply(doc._id, await outcomeOf(doc, false), doc);
  }
  return resultReply(doc._id, await outcomeOf(doc, true), doc);
}

/** The guided form's sealed payload (null for a legacy proposal, which has none). */
function workflowSealedOf(doc: CrmAssistOperationDoc): WorkflowSealed | null {
  const sealed = unseal(doc.sealed);
  return isWorkflowSealed(sealed) ? sealed : null;
}

function reviewOf(doc: CrmAssistOperationDoc): ReviewBlock | undefined {
  return unseal(doc.sealed).review;
}

/** The confirmation's one line (spec B12.4): "<Imperative> <singular> <label>."; a create is named by its own values. */
function summaryOf(cap: ModuleCap, op: OperationOp, values: Record<string, unknown>, target: EntityRef | undefined): string {
  const created = op === 'create' ? titleOf(cap, values) : undefined;
  const named = op === 'create' ? (created !== cap.labels.singular ? created : undefined) : target?.number ?? target?.label;
  return clip(`${scrubIds(`${IMPERATIVE[op]} ${lower(cap.labels.singular)}${named ? ` ${named}` : ''}`)}.`, 500);
}

function confirmationOf(cap: ModuleCap, op: OperationOp, values: Record<string, unknown>, review: ReviewBlock): OperationConfirmation {
  const { id, revision, payloadHash, expiresAt } = review.operation;
  return { operationId: id, revision, payloadHash, expiresAt, summary: summaryOf(cap, op, values, review.target) };
}

/* ── The open form ─────────────────────────────────────────────────────── */

/** The module's write and the caller's form context, when the module still has a guided form for this operation
 * and the caller may still make it (the flag, the write permission, and view for an update). */
async function flowFor(doc: Pick<CrmAssistOperationDoc, 'module' | 'op'>, caller: WorkflowCaller, now: Date): Promise<Flow | { reply: WorkflowReply }> {
  const { identity, tenant } = caller;
  const op = doc.op;
  const wf = workflowModuleFor(doc.module);
  const writable = writableModule(doc.module, op);
  if (!wf || !writable || op === 'delete') return { reply: refused(403, NO_LONGER_WRITABLE) };
  const access = await checkAccess(identity.tenantId, tenant, identity, writable.def, writable.cap, doc.module, op);
  if (!access.ok) return { reply: refused(403, access.message) };
  const ctx = await loadFormContext(wf, op, { identity, tenant, now });
  return { wf, def: writable.def, cap: writable.cap, op, ctx, fields: fieldsFor(wf, op, ctx), gate: gateRelated({ identity, tenant, now }) };
}

function refDeps(flow: Flow, caller: WorkflowCaller, focus: StartInput['focus']): Omit<RefDeps, 'resolved'> {
  return { identity: caller.identity, tenant: caller.tenant, gate: flow.gate, focus, ctx: flow.ctx };
}

/** An update form's record, read again as the write reads it (null when it is gone or out of sight). */
async function targetRecord(flow: Flow, doc: CrmAssistOperationDoc, caller: WorkflowCaller): Promise<Record<string, unknown> | null> {
  if (flow.op !== 'update' || !doc.target) return null;
  const found: unknown = await flow.def.getById!(doc.target.id, caller.identity.tenantId, flow.ctx.scope);
  return found ? toPlain(found) : null;
}

function targetRefOf(cap: ModuleCap, id: string, number: string | undefined, label: string | undefined): FormTarget {
  const href = recordLinkFor(cap.key, id);
  return {
    module: cap.key, id, ...(number ? { number } : {}), label: clip(label || cap.labels.singular, 200), source: cap.group,
    ...(href ? { href } : {}),
  };
}

/** An update form's record as its title names it: its number now, its name as the form last read it. */
function formTargetOf(flow: Flow, doc: CrmAssistOperationDoc, sealed: WorkflowSealed, record: Record<string, unknown> | null): FormTarget | undefined {
  if (flow.op !== 'update' || !doc.target) return undefined;
  const number = record && flow.cap.ids.business ? textOf(record[flow.cap.ids.business]) : undefined;
  return targetRefOf(flow.cap, doc.target.id, number, sealed.source.targetLabel);
}

function runStack(flow: Flow, state: DraftState, record: Record<string, unknown> | null, mode: 'draft' | 'review', caller: WorkflowCaller): Promise<StackResult> {
  return runFormStack({
    wf: flow.wf, def: flow.def, cap: flow.cap, op: flow.op, mode, identity: caller.identity, tenant: caller.tenant, ctx: flow.ctx,
    related: flow.gate, fields: flow.fields, form: state.form, origins: state.origins, masked: state.masked, refs: state.refs, record,
    // A document's lines and the record a create is made from (the stack takes them only for a lines create).
    lines: state.lines, ...(state.from ? { source: state.from } : {}),
  });
}

/** The lines a document create shows (spec B5.6): carried from its source (shown only), or picked from the catalog the
 * caller can read (Add offers its kinds). undefined for any other form. */
function formLinesOf(flow: Flow, state: DraftState, stack: StackResult): FormLines | undefined {
  const spec = flow.op === 'create' ? flow.wf.cap.lines : undefined;
  if (!spec) return undefined;
  const from = state.from;
  const add = from ? [] : spec.add.filter((m) => flow.ctx.refAccess[m] === 'ok');
  return {
    editable: from ? 'none' : 'catalog', add,
    rows: lineRowsOf(stack.lines ?? state.lines, flow.ctx.branchCurrency, from?.number),
    required: spec.required && !from, max: spec.max,
    help: from ? linesFromSource(from.number) : add.length ? LINES_FROM_CATALOG : LINES_HIDDEN,
  };
}

/** The FormBlock of a draft state and its stack result (composeFormBlock validates it and throws when it can't be shown).
 * `at.branchId`: the operation's company, which the full form opens in (L27), whatever company the caller is in now. A
 * document's line errors are shown with the fields' (C2). */
function composeDraft(
  flow: Flow, at: { operationId: string; revision: number; expiresAt: Date; branchId: string | null }, state: DraftState,
  notTaken: readonly string[], stack: StackResult, target: FormTarget | undefined, extra: Extra = {},
): FormBlock {
  const { wf, ctx, op } = flow;
  const { branchId, ...operation } = at;
  const lines = formLinesOf(flow, state, stack);
  return composeFormBlock({
    ...operation, wf, cap: flow.cap, op, ctx, fields: flow.fields, target,
    form: state.form, origins: state.origins, masked: state.masked, candidates: state.candidates, hints: state.hints,
    fieldErrors: { ...stack.fieldErrors, ...(stack.lineErrors ?? {}), ...(extra.fieldErrors ?? {}) }, missing: stack.missing,
    formErrors: [...(extra.formErrors ?? []), ...stack.formErrors], warnings: [...(extra.warnings ?? []), ...stack.warnings],
    notTaken, sideEffects: stack.sideEffects, quickPicks: stack.quickPicks,
    fullFormPrefill: op === 'create' && wf.fullFormPrefill
      ? wf.fullFormPrefill({ form: state.form, refs: stack.refs, values: stack.values, branchId, ctx })
      : null,
    scopeKind: ctx.scope.kind,
    ...(lines ? { lines, totals: stack.totals ?? null } : {}),
    ...(state.from ? { readOnlyKeys: state.from.fixedKeys, fromNumber: state.from.number } : {}),
  });
}

/** The open draft's FormBlock as it is (nothing written). `record`: an update's record, when already read. */
async function renderDraft(
  flow: Flow, doc: CrmAssistOperationDoc, sealed: WorkflowSealed, caller: WorkflowCaller,
  record?: Record<string, unknown> | null, extra: Extra = {},
): Promise<FormBlock> {
  const current = record === undefined ? await targetRecord(flow, doc, caller) : record;
  const gone = flow.op === 'update' && !current ? [TARGET_GONE] : [];
  const state = stateOf(sealed);
  const stack = await runStack(flow, state, current, 'draft', caller);
  return composeDraft(
    flow, { operationId: doc._id, revision: doc.revision, expiresAt: new Date(doc.expiresAt), branchId: doc.branchId ?? null }, state,
    sealed.notTaken, stack, formTargetOf(flow, doc, sealed, current),
    { ...extra, formErrors: [...new Set([...gone, ...(extra.formErrors ?? [])])] },
  );
}

/** The compare-and-set every mutation of an open operation uses (spec B2): the owner, the branch, the status and the
 * revision the step started from, and not expired. null when anything changed meanwhile. */
async function casUpdate(
  doc: CrmAssistOperationDoc, caller: WorkflowCaller, status: 'draft' | 'staged', now: Date,
  set: Partial<CrmAssistOperationDoc>, unset?: { payloadHash: 1 },
): Promise<CrmAssistOperationDoc | null> {
  const { identity } = caller;
  const filter = {
    _id: doc._id, tenantId: identity.tenantId, userId: identity.userId, sessionId: caller.sessionId, branchId: identity.branchId ?? null,
    status, revision: doc.revision, expiresAt: { $gt: now },
  };
  return CrmAssistOperation.findOneAndUpdate(filter, unset ? { $set: set, $unset: unset } : { $set: set }, { new: true })
    .lean() as Promise<CrmAssistOperationDoc | null>;
}

/** Steps 1 to 7 of validate, fill and review (spec B12.2): the caller's own operation, in this branch, an open draft
 * (a review answers FORM_REVIEWED with its card; anything past answers its result), still permitted, at the revision
 * the caller saw ('any': a fill takes the current one) and not past MAX_DRAFT_REVISIONS. */
async function openDraft(operationId: string, caller: WorkflowCaller, now: Date, revision: number | 'any'): Promise<Opened> {
  const { identity } = caller;
  const doc = await findOwned(operationId, identity, caller.sessionId);
  if (!doc) return { ok: false, reply: await missingReply(operationId, caller) };
  if ((doc.branchId ?? null) !== (identity.branchId ?? null)) return { ok: false, reply: refused(409, FORM_BRANCH_MESSAGE) };
  const closed = await closedReply(doc, now);
  if (closed) return { ok: false, reply: closed };
  if (doc.status === 'staged') return { ok: false, reply: refused(409, FORM_REVIEWED, reviewOf(doc)) };
  const sealed = workflowSealedOf(doc);
  if (!sealed) throw new Error('CRM assist: a draft without a guided form');
  const flow = await flowFor(doc, caller, now);
  if ('reply' in flow) return { ok: false, reply: flow.reply };
  if (revision !== 'any' && revision !== doc.revision) {
    return { ok: false, reply: refused(409, FORM_STALE, await renderDraft(flow, doc, sealed, caller)) };
  }
  if (doc.revision >= MAX_DRAFT_REVISIONS) return { ok: false, reply: refused(409, TOO_MANY_CHANGES) };
  return { ok: true, doc, sealed, flow };
}

/** After a lost compare-and-set: what the operation is now (a newer form, its review, or its result). */
async function staleReply(operationId: string, caller: WorkflowCaller, now: Date): Promise<WorkflowReply> {
  // Revision 0 is never a draft's, so a draft answers FORM_STALE with its current block.
  const latest = await openDraft(operationId, caller, now, 0);
  return latest.ok ? refused(409, FORM_STALE) : latest.reply;
}

/** The end of a validate or a fill: the stack again (an update with its record read again), then revision + 1 with the
 * expiry slid, written only if nobody changed the draft meanwhile (null then). */
async function saveDraft(
  flow: Flow, doc: CrmAssistOperationDoc, sealed: WorkflowSealed, state: DraftState, caller: WorkflowCaller, now: Date, extra: Extra,
): Promise<WorkflowReply | null> {
  const record = await targetRecord(flow, doc, caller);
  const stack = await runStack(flow, state, record, 'draft', caller);
  const revision = doc.revision + 1;
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const gone = flow.op === 'update' && !record ? [TARGET_GONE] : [];
  const block = composeDraft(
    flow, { operationId: doc._id, revision, expiresAt, branchId: doc.branchId ?? null }, state, sealed.notTaken, stack,
    formTargetOf(flow, doc, sealed, record), { ...extra, formErrors: [...gone, ...(extra.formErrors ?? [])] },
  );
  const saved = await casUpdate(doc, caller, 'draft', now, {
    revision, sealed: seal(draftSealed(sealed, state, stack)), fieldKeys: fieldKeysOf(stack.values),
    warnings: block.warnings, sideEffects: block.sideEffects, expiresAt, purgeAt: purgeAfter(expiresAt),
  });
  return saved ? { kind: 'form', operationId: doc._id, block, notices: [] } : null;
}

/** Whether an update's record moved on since the form read it: its updatedAt (compare-and-set), or the version token
 * the service checks (kept in the sealed source). */
function versionMoved(doc: CrmAssistOperationDoc, sealed: WorkflowSealed, captured: { version: TargetVersion; token?: VersionToken }): boolean {
  const then = doc.target?.version;
  if (!then) return true;
  if ('updatedAt' in then) return !('updatedAt' in captured.version) || captured.version.updatedAt !== then.updatedAt;
  const was = sealed.source.versionToken ?? {};
  const is = captured.token ?? {};
  return (was.updatedAt ?? null) !== (is.updatedAt ?? null) || (was.__v ?? null) !== (is.__v ?? null);
}

/** The record moved on before Review (spec B12.4): the fields the person left alone (origin source) take its values
 * now, the version is captured again, and the form comes back (revision + 1) with RECORD_CHANGED to check first. */
async function refreshDraft(
  flow: Flow, doc: CrmAssistOperationDoc, sealed: WorkflowSealed, record: Record<string, unknown>,
  captured: { version: TargetVersion; token?: VersionToken }, caller: WorkflowCaller, now: Date,
): Promise<WorkflowReply> {
  const { identity } = caller;
  const [protectedRow] = await applyPIIProtection([record], flow.def.logModule, identity.tenantId, identity.branchId ?? null, identity.role);
  const shown = toPlain(protectedRow);
  const stored = await readStoredRefs(flow.fields, record, refDeps(flow, caller, null));
  const fresh = recordToForm(flow.wf, flow.fields, flow.ctx, shown, stored);
  const state = stateOf(sealed);
  for (const { key } of flow.fields) {
    if ((state.origins[key] ?? 'source') !== 'source') continue;
    if (has(fresh.form, key)) state.form[key] = fresh.form[key];
    else delete state.form[key];
    state.origins[key] = 'source';
    if (stored[key] !== undefined) state.refs[key] = stored[key];
    else delete state.refs[key];
    state.masked = state.masked.filter((k) => k !== key);
    if (fresh.masked.includes(key)) state.masked.push(key);
  }
  const label = titleOf(flow.cap, shown);
  const number = flow.cap.ids.business ? textOf(shown[flow.cap.ids.business]) : undefined;
  const stack = await runStack(flow, state, record, 'draft', caller);
  const revision = doc.revision + 1;
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const target = { id: doc.target!.id, version: captured.version };
  const block = composeDraft(
    flow, { operationId: doc._id, revision, expiresAt, branchId: doc.branchId ?? null }, state, sealed.notTaken, stack,
    targetRefOf(flow.cap, target.id, number, label), { warnings: [RECORD_CHANGED] },
  );
  const saved = await casUpdate(doc, caller, 'draft', now, {
    revision, sealed: seal(draftSealed(sealed, state, stack, keptFrom(sourceOf(sealed.source.startedBy, captured.token, label), sealed))),
    fieldKeys: fieldKeysOf(stack.values), target, warnings: block.warnings, sideEffects: block.sideEffects, expiresAt, purgeAt: purgeAfter(expiresAt),
  });
  return saved ? { kind: 'form', operationId: doc._id, block, notices: [] } : staleReply(doc._id, caller, now);
}

/* ── Values and records from a message, a typed answer or the browser ──── */

/** Why a picked record can't be used for a field (B20). */
function pickProblem(field: WriteFormField, res: Exclude<RefResolution, { state: 'resolved' }>, state: DraftState): string {
  if (res.state !== 'refused') return PICK_RECORD;
  switch (res.reason) {
    case 'bad_id': return REF_GONE;
    case 'not_a_user': return OWNER_NOT_USER;
    case 'outside_parent': {
      const parentKey = field.ref?.within?.field;
      const parent = parentKey ? singleRef(state.refs[parentKey]) : undefined;
      if (field.ref?.module === 'site') return parent ? SITE_OTHER_CUSTOMER : PICK_CUSTOMER_FIRST;
      return field.ref?.module === 'staff' && parent ? staffNotInTeamText(parent.label) : REF_GONE;
    }
    default: return refHiddenText(pluralOf(res.module));
  }
}

/** The help a field gets when the record its words named wasn't picked: several match, none does, the module is out
 * of the caller's reach, or the lookup ran out of time (B20). */
function refHint(field: WriteFormField, res: Exclude<RefResolution, { state: 'resolved' }>, state: DraftState, me: boolean): string {
  if (res.state === 'ambiguous') return ambiguousText(res.text);
  if (res.state === 'not_found') return res.text ? refNotFoundText(field.kind === 'related' ? 'record' : singularOf(res.module), res.text) : PICK_HERE;
  // "Me" with no staff profile to be: the person picks someone.
  return me ? PICK_HERE : pickProblem(field, res, state);
}

/** A record the words named that wasn't picked: the hint (and the choices) on the field. A default the message asked
 * to replace goes, so it isn't kept unseen; a value the person typed or the record holds stays. */
function unpicked(field: WriteFormField, state: DraftState, hint: string, candidates?: EntityChoice[]): void {
  const key = field.key;
  if (state.origins[key] === 'default') {
    delete state.form[key];
    delete state.origins[key];
    delete state.provenance[key];
    delete state.refs[key];
  }
  state.hints[key] = hint;
  if (candidates?.length) state.candidates[key] = candidates.slice(0, FORM_CAPS.candidates);
  else delete state.candidates[key];
}

/** One field's lookup result put into the form: the records found (a list keeps the ones found), the hint and the
 * choices for the rest. No result at all means the lookup ran out of time. */
function applyResolution(
  field: WriteFormField, res: RefResolution | RefResolution[] | undefined, input: RefInput | RefInput[], state: DraftState, origin: FormOrigin,
): void {
  if (res === undefined) {
    unpicked(field, state, PICK_HERE);
    return;
  }
  const results = Array.isArray(res) ? res : [res];
  const picked: StoredRef[] = [];
  for (const r of results) if (r.state === 'resolved' && !picked.some((p) => p.id === r.ref.id)) picked.push(r.ref);
  const problem = results.find((r): r is Exclude<RefResolution, { state: 'resolved' }> => r.state !== 'resolved');
  if (picked.length) {
    setField(state, field.key, field.kind === 'ref_many' ? picked.map((r) => formRefOf(field, r)) : formRefOf(field, picked[0]), origin);
    state.refs[field.key] = field.kind === 'ref_many' ? picked : picked[0];
  }
  if (!problem) return;
  const me = (Array.isArray(input) ? input : [input]).some((i) => 'me' in i);
  const hint = refHint(field, problem, state, me);
  const candidates = problem.state === 'ambiguous' ? problem.candidates : undefined;
  if (!picked.length) {
    unpicked(field, state, hint, candidates);
    return;
  }
  // Some of a list were found: they stay, and the field says what is missing.
  state.hints[field.key] = hint;
  if (candidates?.length) state.candidates[field.key] = candidates.slice(0, FORM_CAPS.candidates);
}

/** Values read from words (spec B12.1 step 7): each as its field holds it. The planner fills only the fields it may
 * (plannerFillable); the grammar's and a server-written choice's are taken as read. Records never come as values. A
 * note on how a date or time was read is kept for applyNotes. */
function applyValues(
  flow: Flow, state: DraftState, values: Record<string, WriteValue> | undefined, origin: FormOrigin, plannerOnly: boolean,
  notes: Record<string, FieldNote>,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    const field = flow.fields.find((f) => f.key === key);
    if (!field || REF_KINDS.has(field.kind) || (plannerOnly && !field.plannerFillable)) continue;
    const read = writeValueToForm(field, value, flow.ctx);
    if (read.value !== undefined) setField(state, key, read.value, origin);
    if (read.note && !has(notes, key)) notes[key] = read.note;
  }
}

/** The records named in words (or by "me", the screen, a choice's id), looked up under each module's gates and scope
 * by `deadline`, parents first and within the form's earlier picks (a site within the customer already chosen). A
 * ticket's Related field takes words only for customers and contacts (L22). */
async function applyRefs(
  flow: Flow, state: DraftState, refs: Record<string, RefInput | RefInput[]> | undefined, deps: Omit<RefDeps, 'resolved'>,
  deadline: number, origin: FormOrigin,
): Promise<void> {
  const named = flow.fields.filter((f) => REF_KINDS.has(f.kind) && !!refs && has(refs, f.key));
  if (!refs || !named.length) return;
  const asked: Record<string, RefInput | RefInput[]> = {};
  for (const field of named) asked[field.key] = refs[field.key];
  const words = (input: RefInput | RefInput[]) => (Array.isArray(input) ? input : [input]).every((i) => 'text' in i);
  const lookups = named.map((field) => (words(asked[field.key]) ? textRefField(flow.cap.key, field) : field));
  const answer = await resolveFieldRefs(lookups, asked, { ...deps, resolved: { ...state.refs } }, deadline);
  for (const field of named) applyResolution(field, answer[field.key], asked[field.key], state, origin);
}

/** L22: a ticket or call "for" (or "with") someone also takes the words as its contact name, when the message
 * gave none itself. */
function applyContactName(flow: Flow, state: DraftState, intent: WriteIntent, origin: FormOrigin): void {
  const forRef = flow.wf.cap.forRef;
  if (flow.op !== 'create' || !forRef || has(intent.values ?? {}, 'contactName')) return;
  const forField = flow.fields.find((f) => f.key === forRef);
  if (forField?.kind !== 'related' || !flow.fields.some((f) => f.key === 'contactName' && f.kind === 'text')) return;
  const input = intent.refs?.[forRef];
  const text = input && !Array.isArray(input) && 'text' in input ? input.text.replace(/\s+/g, ' ').trim() : '';
  if (text && isEmptyValue(state.form.contactName)) setField(state, 'contactName', text, origin);
}

/** How the message's dates and times were read (L14). A date-time without a time, or at midnight, is a field error the
 * stack keeps giving until it is fixed. An hour without am/pm (whose hour is never kept) and a day that couldn't be
 * read are field errors now and stay as the field's help until the field changes. A date field given a time keeps
 * only the day. */
function applyNotes(flow: Flow, state: DraftState, notes: Record<string, FieldNote>, errors: Record<string, string>): void {
  for (const [key, note] of Object.entries(notes)) {
    const field = flow.fields.find((f) => f.key === key);
    if (!field) continue;
    switch (note) {
      case 'add_time': errors[key] = ADD_TIME; break;
      case 'midnight': errors[key] = MIDNIGHT; break;
      case 'am_pm': {
        errors[key] = AM_PM;
        state.hints[key] = AM_PM;
        const value = state.form[key];
        if (typeof value === 'string' && value.length > 10) state.form[key] = value.slice(0, 10);
        break;
      }
      case 'which_day':
        errors[key] = WHICH_DAY;
        state.hints[key] = WHICH_DAY;
        break;
      case 'time_dropped':
        if (!field.help) state.hints[key] = TIME_NOT_SAVED;
        break;
      default:
        break;
    }
  }
}

/** The records picked on the form (spec B12.2 step 8): the same record again is kept as resolved; a new one is read
 * again under its module's gates and scope, within its parent on the form. One that can't be used gives a field error
 * and is left out (a single record clears the field). */
async function pickRecords(
  field: WriteFormField, value: FormValue, state: DraftState, deps: Omit<RefDeps, 'resolved'>, errors: Record<string, string>,
): Promise<void> {
  if (isEmptyValue(value)) {
    clearField(field, state, 'user');
    return;
  }
  const picks = field.kind === 'ref_many'
    ? (Array.isArray(value) && (value as unknown[]).every(isFormRef) ? value as FormRefValue[] : null)
    : (isFormRef(value) ? [value] : null);
  if (!picks) {
    clearField(field, state, 'user');
    errors[field.key] = PICK_RECORD;
    return;
  }
  const known = refList(state.refs[field.key]).filter((r) => HEX_ID.test(r.id));
  const out: StoredRef[] = [];
  let problem: string | undefined;
  for (const pick of picks.slice(0, field.ref?.maxItems ?? FORM_CAPS.multi)) {
    const same = known.find((r) => r.id.toLowerCase() === pick.ref.toLowerCase() && (!pick.module || pick.module === r.module));
    if (same) {
      if (!out.some((r) => r.id === same.id)) out.push(same);
      continue;
    }
    const input: RefInput = pick.module ? { ref: pick.ref, module: pick.module } : { ref: pick.ref };
    const res = await resolveFieldRef(field, input, { ...deps, resolved: state.refs });
    if (res.state === 'resolved') {
      if (!out.some((r) => r.id === res.ref.id)) out.push(res.ref);
    } else {
      problem ??= pickProblem(field, res, state);
    }
  }
  if (!out.length) clearField(field, state, 'user');
  else {
    setField(state, field.key, field.kind === 'ref_many' ? out.map((r) => formRefOf(field, r)) : formRefOf(field, out[0]), 'user');
    state.refs[field.key] = field.kind === 'ref_many' ? out : out[0];
  }
  if (problem) errors[field.key] = problem;
}

/** The work order's address prefill inputs (L29): an address typed on the form (refuseMasked), and the customer and
 * site picked for it. null for any other form. */
function addressInputsOf(fields: readonly WriteFormField[]): { customer: string; site?: string } | null {
  const address = fields.some((f) => f.key === 'address' && f.refuseMasked);
  const customer = fields.find((f) => f.kind === 'ref' && f.ref?.module === 'customer');
  const site = fields.find((f) => f.kind === 'ref' && f.ref?.module === 'site');
  return address && customer ? { customer: customer.key, ...(site ? { site: site.key } : {}) } : null;
}

/** The address from the site or customer picked, put in only over an empty or earlier-prefilled address (L29). */
async function prefillAddress(flow: Flow, state: DraftState, inputs: { customer: string; site?: string }): Promise<void> {
  const customer = singleRef(state.refs[inputs.customer]);
  const site = inputs.site ? singleRef(state.refs[inputs.site]) : undefined;
  applyAddressPrefill(state, await addressPrefill(flow.ctx, { ...(customer ? { customer } : {}), ...(site ? { site } : {}) }, flow.gate));
}

/** What a change brings with it: the fields it clears (the screen's cascade: a new customer clears the site, a new
 * team the staff) unless they were given too, and the work order's address prefill again when its customer or site
 * changed. A cleared field that was masked is cleared for real, so a hidden site of another customer isn't kept. */
async function afterChange(flow: Flow, state: DraftState, changed: Set<string>, given: ReadonlySet<string>, origin: FormOrigin): Promise<void> {
  for (const field of flow.fields) {
    const parent = field.ref?.clearedBy;
    if (!parent || !changed.has(parent) || given.has(field.key)) continue;
    const masked = state.masked.includes(field.key);
    if (!masked && isEmptyValue(state.form[field.key])) continue;
    state.masked = state.masked.filter((k) => k !== field.key);
    clearField(field, state, origin);
    changed.add(field.key);
  }
  const address = addressInputsOf(flow.fields);
  if (address && (changed.has(address.customer) || (address.site !== undefined && changed.has(address.site)))) {
    await prefillAddress(flow, state, address);
  }
}

/* ── Start ─────────────────────────────────────────────────────────────── */

const pastDeadline = (input: StartInput) => Date.now() >= input.deadline - CREATE_MARGIN_MS;
const timeoutReply = () => noticeReply('form_timeout', FORM_TIMEOUT);

/** The words of the request not used (L3): the reader's, then the start's own (lines not priced, a record a source
 * fixes). */
function notTakenOf(input: StartInput, more: readonly string[] = []): string[] {
  return [...(input.notTaken ?? []), ...more].filter((w) => typeof w === 'string' && w.trim()).slice(0, FORM_CAPS.notTaken).map((w) => clip(w, 120));
}

/** SOURCE_NOT_SUPPORTED (B12): "An invoice can't be made from another record here." */
function sourceNotSupportedText(cap: ModuleCap): string {
  const singular = lower(cap.labels.singular);
  const a = article(singular);
  return `${a.charAt(0).toUpperCase()}${a.slice(1)} ${singular} can't be made from another record here.`;
}

/** The words of a record named for a field the source fixes, for "Not taken". */
function refWords(input: RefInput | RefInput[]): string[] {
  return (Array.isArray(input) ? input : [input]).flatMap((i) => ('text' in i && wordsOf(i.text) ? [wordsOf(i.text)] : []));
}

function unversionedText(cap: ModuleCap): string {
  return `This ${lower(cap.labels.singular)} can't be changed from the assistant because its version can't be checked. Use the ${lower(cap.labels.plural)} page.`;
}

function targetNotFoundText(cap: ModuleCap, asked: { number: string } | { text: string }, byNumber: boolean): string {
  const singular = lower(cap.labels.singular);
  const typed = clip('number' in asked ? asked.number : asked.text, 100);
  return byNumber
    ? `I couldn't find ${article(singular)} ${singular} numbered ${typed} that you can see.`
    : `I couldn't find ${article(singular)} ${singular} named "${typed}" that you can see.`;
}

/** A match named by the whole text typed: its name or its number, case and spacing aside (L30). */
function isWholeName(match: EntityMatch, text: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(text);
  return norm(match.label) === want || (!!match.number && norm(match.number) === want);
}

function chooseTarget(
  cap: ModuleCap, intent: WriteIntent, matches: EntityMatch[], more: boolean, reason: 'ambiguous_entity' | 'duplicate_number' | 'no_focus', text?: string,
): { reply: WorkflowReply } {
  return { reply: { kind: 'clarify', composed: composeTargetChoices({ cap, intent, matches, more, reason, ...(text ? { text } : {}) }) } };
}

/** The one record a number, a name or the screen names, read under the module's own gates and scope; else the choice
 * (several match, or no record on screen) or the notice. A number shared by several records offers each (they have no
 * unique index); a name picks its record only when it is the only match and named whole (L30). */
async function pickTarget(
  input: StartInput, asked: { number: string } | { text: string } | { focus: true }, cap: ModuleCap,
  side: Extract<RelatedGateResult, { ok: true }>,
): Promise<{ id: string } | { reply: WorkflowReply }> {
  const { intent } = input;
  const singular = lower(cap.labels.singular);
  if ('focus' in asked) {
    const focus = input.focus && input.focus.module === cap.key ? input.focus : null;
    const onScreen = focus ? (await resolveEntity(side.cap, { focus: true }, side.ctx, { focus })).matches[0] : undefined;
    if (onScreen) return { id: onScreen.id };
    const recent = await recentEntities(side.cap, side.ctx, { limit: RECENT_CHOICES });
    if (!recent.length) {
      return { reply: noticeReply('target_not_found', `No ${singular} is open, and you can't see any ${lower(cap.labels.plural)} to choose from.`) };
    }
    return chooseTarget(cap, intent, recent, false, 'no_focus');
  }
  const typed = ('number' in asked ? asked.number : asked.text).replace(/\s+/g, ' ').trim();
  if (!typed) return { reply: noticeReply('target_not_found', notFoundMessage(cap)) };
  const own = businessNumberOf(typed);
  const byNumber = 'number' in asked || (!!own && own.module === cap.key && !!cap.ids.business);
  const found = await resolveEntity(side.cap, { text: typed }, side.ctx, { limit: MAX_ENTITY_MATCHES });
  if (byNumber) {
    const want = (own?.number ?? typed).toUpperCase();
    const numbered = found.matches.filter((m) => m.number?.toUpperCase() === want);
    if (numbered.length === 1) return { id: numbered[0].id };
    if (numbered.length > 1) return chooseTarget(cap, intent, numbered, found.more, 'duplicate_number', typed);
    return { reply: noticeReply('target_not_found', targetNotFoundText(cap, asked, true)) };
  }
  if (!found.matches.length) return { reply: noticeReply('target_not_found', targetNotFoundText(cap, asked, false)) };
  const only = found.matches.length === 1 && !found.more ? found.matches[0] : undefined;
  if (only && isWholeName(only, typed)) return { id: only.id };
  return chooseTarget(cap, intent, found.matches, found.more, 'ambiguous_entity', typed);
}

/** Whether the contacts list shows this contact to the caller (through its owner's name, which the write's own
 * lookup, ids only, doesn't follow). */
async function listedContact(gate: RelatedGate, id: string): Promise<boolean> {
  const side = await gate('contact');
  return side.ok && (await resolveEntity(side.cap, { ref: id }, side.ctx)).matches.length > 0;
}

/** Step 4 of a start (spec B12.1): the record an update or delete names, read as the write itself reads it (contacts:
 * ids only), not locked for this caller and with a version to check; else the notice or the choice to show. */
async function findTarget(
  input: StartInput, op: 'update' | 'delete', def: CrmWriteModuleDef, cap: ModuleCap, ctx: FormContext, gate: RelatedGate, caller: WorkflowCaller,
): Promise<FoundTarget | { reply: WorkflowReply }> {
  const { identity } = caller;
  const tenantId = identity.tenantId;
  const asked = input.intent.target ?? { focus: true as const };
  let id: string;
  let listed = false;
  if ('ref' in asked) {
    id = asked.ref;
  } else {
    const side = await gate(cap.key);
    if (!side.ok) return { reply: noticeReply('target_not_found', notFoundMessage(cap)) };
    const picked = await pickTarget(input, asked, cap, side);
    if ('reply' in picked) return picked;
    id = picked.id;
    listed = true;
  }
  const found: unknown = await def.getById!(id, tenantId, ctx.scope);
  if (!found) {
    if (cap.key === 'contact' && (listed || await listedContact(gate, id))) {
      return { reply: noticeReply('name_owned_contact', NAME_OWNED_CONTACT, 'warning', recordLinkFor(cap.key, id)) };
    }
    return { reply: noticeReply('target_not_found', notFoundMessage(cap)) };
  }
  const raw = toPlain(found);
  const readId = raw._id !== undefined && raw._id !== null && HEX_ID.test(String(raw._id)) ? String(raw._id).toLowerCase() : id;
  if (!isAdminIdentity(identity) && isRecordLockModule(def.logModule)) {
    const lock = await getLockStatus(tenantId, def.logModule, readId).catch(() => null);
    if (lock?.isLocked) return { reply: noticeReply('target_locked', lockedMessage(cap), 'warning') };
  }
  const captured = captureVersion(def, found, op);
  if (!captured) return { reply: noticeReply('target_unversioned', unversionedText(cap), 'warning') };
  const [protectedRow] = await applyPIIProtection([raw], def.logModule, tenantId, identity.branchId ?? null, identity.role);
  const shown = toPlain(protectedRow);
  const number = cap.ids.business ? textOf(shown[cap.ids.business]) : undefined;
  return { id: readId, raw, shown, captured, ...(number ? { number } : {}), label: titleOf(cap, shown) };
}

/** The operation document a start creates, before its status-specific parts. */
async function newDoc(
  operationId: string, caller: WorkflowCaller, module: string, op: OperationOp,
): Promise<Pick<CrmAssistOperationDoc, '_id' | 'tenantId' | 'userId' | 'actorEmail' | 'role' | 'roleId' | 'branchId' | 'sessionId' | 'module' | 'op' | 'origin' | 'claimedAt'>> {
  const { identity } = caller;
  const actor = await resolveAssistantAuditActor(identity);
  return {
    _id: operationId, tenantId: identity.tenantId, userId: identity.userId, actorEmail: actor.email, role: actor.role,
    roleId: identity.roleId ?? null, branchId: identity.branchId ?? null, sessionId: caller.sessionId, module, op, origin: 'workflow',
    claimedAt: null,
  };
}

/** Step 5: a delete goes straight to its review (no form, L10), unless the module's pre-check refuses it. */
async function startDelete(
  input: StartInput, caller: WorkflowCaller, now: Date, wf: WorkflowModule, def: CrmWriteModuleDef, cap: ModuleCap, ctx: FormContext,
  gate: RelatedGate, target: FoundTarget,
): Promise<WorkflowReply> {
  const { identity, tenant } = caller;
  const ruled = wf.rules ? await wf.rules.check({
    op: 'delete', mode: 'review', identity, tenant, ctx, values: {}, form: {}, refs: {}, changed: new Set<string>(), record: target.raw, related: gate,
  }) : null;
  if (ruled?.blocked) return noticeReply('delete_blocked', ruled.blocked, 'warning', recordLinkFor(cap.key, target.id));

  const operationId = newOperationId();
  const expiresAt = new Date(now.getTime() + STAGED_TTL_MS);
  const targetDoc = { id: target.id, version: target.captured.version };
  const payloadHash = computePayloadHash({
    module: cap.key, op: 'delete', recordId: target.id, values: {}, version: hashVersion(targetDoc, target.captured.token),
  });
  const review = composeWorkflowReview({
    operationId, revision: 1, payloadHash, expiresAt, wf, cap, def, op: 'delete', ctx,
    target: targetRefOf(cap, target.id, target.number, target.label), changes: [], shown: target.shown, refs: {},
    warnings: ruled?.warnings ?? [], sideEffects: workflowSideEffects(wf, 'delete', ruled?.sideEffects ?? []),
    editable: false, scopeKind: ctx.scope.kind,
  });
  const sealed: WorkflowSealed = {
    v: 2, form: {}, origins: {}, masked: [], refs: {}, candidates: {}, hints: {}, provenance: {}, notTaken: notTakenOf(input), values: {},
    review, source: sourceOf(input.source, target.captured.token, target.label),
  };
  const base = await newDoc(operationId, caller, cap.key, 'delete');
  if (pastDeadline(input)) return timeoutReply();
  const doc: CrmAssistOperationDoc = {
    ...base, status: 'staged', revision: 1, sealed: seal(sealed), fieldKeys: [], target: targetDoc, payloadHash,
    sideEffects: review.sideEffects, warnings: review.warnings, expiresAt, purgeAt: purgeAfter(expiresAt),
  };
  await supersedeSessionOperations(identity.tenantId, identity.userId, caller.sessionId, now);
  await CrmAssistOperation.create(doc);
  await auditOperationStep(doc, 'staged');
  return { kind: 'review', operationId, block: review, notices: [], confirmation: confirmationOf(cap, 'delete', {}, review) };
}

/** Steps 6 to 10: a create's or an update's draft. `start`: what a create made from another record starts from (its
 * module's source read it, spec B5.6). */
async function startForm(
  input: StartInput, caller: WorkflowCaller, now: Date, flow: Flow, target: FoundTarget | null, start?: Extract<SourceStart, { ok: true }>,
): Promise<WorkflowReply> {
  const { identity } = caller;
  const { intent } = input;
  const { wf, cap, op } = flow;
  const deps = refDeps(flow, caller, input.focus);
  const spec = op === 'create' ? wf.cap.lines : undefined;
  // The start's own words not taken and warnings, shown with its form.
  const notTaken: string[] = [];
  const warnings: string[] = [];

  // 6. Where the form starts: a create's defaults, or the record as this caller may see it (PII masked, L10);
  // copies, since the steps below change them.
  const state = emptyState();
  if (!target) {
    const defaults = createDefaults(wf, flow.fields, flow.ctx);
    Object.assign(state, {
      form: { ...defaults.form }, origins: { ...defaults.origins }, provenance: { ...defaults.provenance }, refs: { ...defaults.refs },
    });
    if (start) {
      // The record it is made from: its values (origin default, from the source document; not through setField, which
      // drops the provenance), their records and help, its lines. Lines in the message are not added to them.
      for (const [key, value] of Object.entries(start.form)) {
        state.form[key] = value;
        state.origins[key] = 'default';
        state.provenance[key] = 'source_document';
      }
      Object.assign(state.refs, start.refs);
      Object.assign(state.hints, start.hints);
      state.lines = [...start.lines];
      state.from = start.from;
      warnings.push(...start.warnings);
      const typed = (intent.lines ?? []).map((line) => wordsOf(line.text)).filter(Boolean);
      if (typed.length) {
        notTaken.push(...typed);
        warnings.push(linesFromSourceNotTaken(start.from.number));
      }
    } else if (spec && intent.lines?.length) {
      // The catalog lines the message named, priced from the records the caller can see (M13).
      const typed = await resolveIntentLines(intent.lines, spec, flow.gate, input.deadline - REF_MARGIN_MS);
      state.lines = typed.lines;
      notTaken.push(...typed.notTaken);
      warnings.push(...typed.warnings);
    }
  } else {
    const stored = await readStoredRefs(flow.fields, target.raw, deps);
    const fromRecord = recordToForm(wf, flow.fields, flow.ctx, target.shown, stored);
    Object.assign(state, { form: { ...fromRecord.form }, origins: { ...fromRecord.origins }, masked: [...fromRecord.masked], refs: { ...stored } });
  }

  // 7. What the message asked for, origin suggested. A value or record for a field the source fixes is not taken (the
  // words of such a record go to "Not taken").
  const fixed = new Set(state.from?.fixedKeys ?? []);
  const values = withoutKeys(intent.values, fixed);
  const refs = withoutKeys(intent.refs, fixed);
  for (const key of fixed) if (intent.refs && has(intent.refs, key)) notTaken.push(...refWords(intent.refs[key]));
  const before = valueKeys(flow.fields, state);
  const notes: Record<string, FieldNote> = { ...(input.fieldNotes ?? {}) };
  const errors: Record<string, string> = {};
  applyValues(flow, state, values, 'suggested', input.source === 'planner', notes);
  await applyRefs(flow, state, refs, deps, input.deadline - REF_MARGIN_MS, 'suggested');
  applyContactName(flow, state, intent, 'suggested');
  applyNotes(flow, state, notes, errors);
  const given = new Set([...Object.keys(values ?? {}), ...Object.keys(refs ?? {})]);
  await afterChange(flow, state, changedSince(flow.fields, state, before), given, 'suggested');
  // A create made from another record whose address it left empty: the address of the customer it fixes, once, when
  // the caller can see that customer (the composed address for a customer-PII viewer, else the hint). A hidden
  // customer keeps the source's own hint.
  const address = state.from ? addressInputsOf(flow.fields) : null;
  if (address && isEmptyValue(state.form.address) && singleRef(state.refs[address.customer])) await prefillAddress(flow, state, address);

  // 8. The stack, then the form as it will be shown (nothing is created when it can't be). The payload holds lines only
  // for a document create (C7).
  const stack = await runStack(flow, state, target ? target.raw : null, 'draft', caller);
  const operationId = newOperationId();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const { lines, from, ...formState } = state;
  const sealed: WorkflowSealed = {
    v: 2, ...formState, refs: stack.refs, notTaken: notTakenOf(input, notTaken), values: stack.values,
    ...(spec || lines.length ? { lines: stack.lines ?? lines } : {}),
    source: { ...sourceOf(input.source, target?.captured.token, target?.label), ...(from ? { from } : {}) },
  };
  // The draft is created in the caller's company (newDoc), so its full form opens there.
  const block = composeDraft(
    flow, { operationId, revision: 1, expiresAt, branchId: identity.branchId ?? null }, state, sealed.notTaken, stack,
    target ? targetRefOf(cap, target.id, target.number, target.label) : undefined, { fieldErrors: errors, warnings },
  );

  // 9. The draft, replacing the session's open operation (L2); nothing when the deadline has passed.
  const base = await newDoc(operationId, caller, cap.key, op);
  if (pastDeadline(input)) return timeoutReply();
  const doc: CrmAssistOperationDoc = {
    ...base, status: 'draft', revision: 1, sealed: seal(sealed), fieldKeys: fieldKeysOf(stack.values),
    ...(target ? { target: { id: target.id, version: target.captured.version } } : {}),
    sideEffects: block.sideEffects, warnings: block.warnings, expiresAt, purgeAt: purgeAfter(expiresAt),
  };
  await supersedeSessionOperations(identity.tenantId, identity.userId, caller.sessionId, now);
  await CrmAssistOperation.create(doc);
  await auditOperationStep(doc, 'started');

  // 10.
  return { kind: 'form', operationId, block, notices: [] };
}

/** A guided form (or, for a delete, its review) from a write intent (spec B12.1). not_workflow: the module has no
 * guided form for this operation; the caller answers it as before. */
export async function startWorkflow(input: StartInput, caller: WorkflowCaller): Promise<WorkflowReply> {
  const { identity, tenant } = caller;
  const now = caller.now ?? new Date();
  const { module, op } = input.intent;

  // 1. A guided form for this module and operation, and the module map's write for it. An operation the module
  // answers with a notice instead (an invoice or quotation delete, M22) gets it before any permission check or read.
  const wf = workflowModuleFor(module);
  const refusedText = wf && !wf.cap.ops.includes(op) ? wf.cap.refused?.[op] : undefined;
  if (refusedText) return noticeReply('op_refused', refusedText, 'info', listLinkFor(module));
  const writable = wf && wf.cap.ops.includes(op) ? writableModule(module, op) : null;
  if (!wf || !writable) return { kind: 'not_workflow' };
  const { def, cap } = writable;

  // 2. The module's switch and the caller's permission (update and delete also need view).
  const access = await checkAccess(identity.tenantId, tenant, identity, def, cap, module, op);
  if (!access.ok) return noticeReply(access.code === 'disabled' ? 'module_disabled' : 'no_permission', access.message, 'warning');

  // 3.
  const ctx = await loadFormContext(wf, op, { identity, tenant, now });
  const gate = gateRelated({ identity, tenant, now });
  if (op === 'create') {
    const flow: Flow = { wf, def, cap, op, ctx, fields: fieldsFor(wf, op, ctx), gate };
    // A create made from another record (an invoice from a work order): the module's own source reads it and says
    // whether it can be made (a refusal is its reply: no draft, no audit).
    const from = input.intent.from;
    if (!from) return startForm(input, caller, now, flow, null);
    if (!wf.source) return noticeReply('source_refused', sourceNotSupportedText(cap));
    const started = await wf.source.start({ intent: input.intent, from, focus: input.focus, identity, tenant, gate, ctx });
    if (!started.ok) return started.reply;
    return startForm(input, caller, now, flow, null, started);
  }

  // 4. The record an update or delete names.
  const target = await findTarget(input, op, def, cap, ctx, gate, caller);
  if ('reply' in target) return target.reply;

  // 5. A delete's review; else the update's form.
  if (op === 'delete') return startDelete(input, caller, now, wf, def, cap, ctx, gate, target);
  return startForm(input, caller, now, { wf, def, cap, op, ctx, fields: fieldsFor(wf, op, ctx), gate }, target);
}

/** The browser's changed values (spec B12.2): merged as the person's own, the stack again, revision + 1. A stale
 * revision gets 409 with the latest block; nothing but the operation is written, and no audit entry (L12). A document
 * create also takes the browser's whole line list (Increment 7, spec B5.6): rows kept, removed or added (priced from
 * the catalog here); a list that can't be this form's is refused whole (400), as is a line list on a form without
 * lines or with lines from another record, and a value for a field that record fills. */
export async function validateDraft(
  operationId: string, body: { revision: number; values: Record<string, FormValue>; lines?: LineEdit[] }, caller: WorkflowCaller,
): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  const opened = await openDraft(operationId, caller, now, body.revision);
  if (!opened.ok) return opened.reply;
  const { doc, sealed, flow } = opened;
  const given = new Set(Object.keys(body.values));
  const fields = flow.fields.filter((field) => given.has(field.key));
  if (fields.length !== given.size) return refused(400, UNKNOWN_FIELD);
  const from = sealed.source.from;
  if (from?.fixedKeys.some((key) => given.has(key))) return refused(400, FIXED_FIELD);
  const spec = flow.op === 'create' ? flow.wf.cap.lines : undefined;
  if (body.lines !== undefined && !spec) return refused(400, LINES_NONE);
  if (body.lines !== undefined && from) return refused(400, LINES_FIXED);

  const state = stateOf(sealed);
  const errors: Record<string, string> = {};
  if (body.lines !== undefined && spec) {
    const edited = await applyLineEdits(state.lines, body.lines, spec, flow.gate);
    if (!edited.ok) return refused(400, edited.message);
    state.lines = edited.lines;
    Object.assign(errors, edited.errors);
  }
  const changed = new Set<string>();
  const deps = refDeps(flow, caller, null);
  // Parents first, so a customer and a site picked together are checked together.
  for (const field of [...fields.filter((f) => !f.ref?.within), ...fields.filter((f) => !!f.ref?.within)]) {
    const before = valueKey(state.form[field.key]);
    const value = body.values[field.key];
    if (REF_KINDS.has(field.kind)) await pickRecords(field, value, state, deps, errors);
    else setField(state, field.key, value, 'user');
    if (before !== valueKey(state.form[field.key])) changed.add(field.key);
  }
  await afterChange(flow, state, changed, given, 'user');
  return (await saveDraft(flow, doc, sealed, state, caller, now, { fieldErrors: errors })) ?? staleReply(operationId, caller, now);
}

/** A typed answer for the open draft (spec B12.3): as validate, with the values read by each field's kind and the
 * records found by name (origin suggested), on the draft's current revision. A race with the browser is retried once.
 * A value or record for a field the record a create is made from fills is skipped; typed answers never change lines. */
export async function applyFill(operationId: string, fill: { values: Record<string, WriteValue>; refs: Record<string, RefInput | RefInput[]>;
  source: 'grammar' | 'planner'; fieldNotes?: Record<string, FieldNote> }, caller: WorkflowCaller): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = await openDraft(operationId, caller, now, 'any');
    if (!opened.ok) return opened.reply;
    const { doc, sealed, flow } = opened;
    const state = stateOf(sealed);
    const fixed = new Set(state.from?.fixedKeys ?? []);
    const values = withoutKeys(fill.values, fixed);
    const refs = withoutKeys(fill.refs, fixed);
    const before = valueKeys(flow.fields, state);
    const notes: Record<string, FieldNote> = { ...(fill.fieldNotes ?? {}) };
    const errors: Record<string, string> = {};
    applyValues(flow, state, values, 'suggested', fill.source === 'planner', notes);
    await applyRefs(flow, state, refs, refDeps(flow, caller, null), Date.now() + FILL_REF_BUDGET_MS, 'suggested');
    applyNotes(flow, state, notes, errors);
    const changed = changedSince(flow.fields, state, before);
    await afterChange(flow, state, changed, new Set([...Object.keys(values ?? {}), ...Object.keys(refs ?? {})]), 'suggested');
    const saved = await saveDraft(flow, doc, sealed, state, caller, now, { fieldErrors: errors });
    if (saved) return saved;
  }
  return staleReply(operationId, caller, now);
}

/** The keys a field writes, as form-stack.ts writes them: a related record's two or three, an owner also the keys it
 * sets (leadOwner). */
function writeKeysOf(field: WriteFormField): string[] {
  if (field.kind === 'related') {
    return field.related?.writesLabel ? ['relatedModule', 'relatedId', 'relatedLabel'] : ['relatedModule', 'relatedId'];
  }
  return [field.key, ...(field.sets ?? []).map((s) => s.key)];
}

/** An update's values reduced to what really differs from the record now (spec B12.4), except a value typed over a
 * hidden one (a masked field, L10): that is always a change, in its own place and with no before. Compared with the
 * hidden value, the review would tell whether a guess equals it (by its row, or by NOTHING_CHANGES); written again,
 * an equal value changes nothing. Confirm recomputes the same value for it (B12.8 step 6). */
function updateChanges(
  flow: Flow, state: DraftState, values: Record<string, unknown>, plain: unknown,
): { values: Record<string, unknown>; changes: FieldChange[] } {
  const typed = new Set(flow.fields.filter((f) => state.masked.includes(f.key) && !isEmptyValue(state.form[f.key])).flatMap(writeKeysOf));
  const out: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  for (const [key, after] of Object.entries(values)) {
    if (typed.has(key)) {
      out[key] = after;
      changes.push({ key, before: undefined, after });
      continue;
    }
    const reduced = reduceToChanges({ [key]: after }, plain);
    Object.assign(out, reduced.values);
    changes.push(...reduced.changes);
  }
  return { values: out, changes };
}

/** Review (spec B12.4): the stack in review mode on the draft as it is; not ready answers the form with its errors
 * (nothing written). Ready: an update reduced to what really changes against the record now, the version captured
 * again, the review and the hash, then staged (revision + 1, 10 minutes) with its confirmation. An update whose
 * record moved on is refreshed instead and comes back as a form to check. */
export async function reviewDraft(operationId: string, body: { revision: number | 'latest' }, caller: WorkflowCaller): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  const { identity } = caller;
  const opened = await openDraft(operationId, caller, now, body.revision === 'latest' ? 'any' : body.revision);
  if (!opened.ok) return opened.reply;
  const { doc, sealed, flow } = opened;
  const { wf, def, cap, ctx, op } = flow;
  const asForm = async (record: Record<string, unknown> | null, extra: Extra = {}): Promise<WorkflowReply> => (
    { kind: 'form', operationId: doc._id, block: await renderDraft(flow, doc, sealed, caller, record, extra), notices: [] }
  );

  // The record an update changes: still there, not locked for this caller, versioned, and as the form read it.
  let record: Record<string, unknown> | null = null;
  let captured: { version: TargetVersion; token?: VersionToken } | null = null;
  if (op === 'update') {
    record = await targetRecord(flow, doc, caller);
    if (!record || !doc.target) return asForm(null);
    if (!isAdminIdentity(identity) && isRecordLockModule(def.logModule)) {
      const lock = await getLockStatus(identity.tenantId, def.logModule, doc.target.id).catch(() => null);
      if (lock?.isLocked) return asForm(record, { formErrors: [lockedMessage(cap)] });
    }
    captured = captureVersion(def, record, 'update');
    if (!captured) return asForm(record, { formErrors: [unversionedText(cap)] });
    if (versionMoved(doc, sealed, captured)) return refreshDraft(flow, doc, sealed, record, captured, caller, now);
  }

  const state = stateOf(sealed);
  const stack = await runStack(flow, state, record, 'review', caller);
  const current = { operationId: doc._id, revision: doc.revision, expiresAt: new Date(doc.expiresAt), branchId: doc.branchId ?? null };
  const formTarget = formTargetOf(flow, doc, sealed, record);
  if (!stack.ready) return { kind: 'form', operationId: doc._id, block: composeDraft(flow, current, state, sealed.notTaken, stack, formTarget), notices: [] };

  // What is written: a create's every value; an update's values that really differ from the record now (and every
  // value typed over a hidden one).
  let values = stack.values;
  let changes: FieldChange[];
  let shown: Record<string, unknown> = {};
  if (record) {
    // Compared with the stored values, decrypted for the comparison only (never shown).
    const [plain] = await applyPIIProtection([record], def.logModule, identity.tenantId, identity.branchId ?? null, 'SUPER_ADMIN');
    const reduced = updateChanges(flow, state, stack.values, plain);
    if (!reduced.changes.length) {
      return { kind: 'form', operationId: doc._id, block: composeDraft(flow, current, state, sealed.notTaken, stack, formTarget, { formErrors: [NOTHING_CHANGES_MESSAGE] }), notices: [] };
    }
    values = reduced.values;
    changes = reduced.changes;
    shown = toPlain((await applyPIIProtection([record], def.logModule, identity.tenantId, identity.branchId ?? null, identity.role))[0]);
  } else {
    changes = createChanges(values);
  }
  // A document create's lines are shown as its lines, with the totals the stack worked out, never as changes. Their
  // prices are the ones just read again (the stack's lines), which the staged payload keeps and the hash covers.
  const spec = op === 'create' ? wf.cap.lines : undefined;
  if (spec) changes = changes.filter((change) => !LINE_WRITE_KEYS.has(change.key));

  const revision = doc.revision + 1;
  const expiresAt = new Date(now.getTime() + STAGED_TTL_MS);
  const targetDoc = record && captured && doc.target ? { id: doc.target.id, version: captured.version } : undefined;
  const label = record ? titleOf(cap, shown) : undefined;
  const number = record && cap.ids.business ? textOf(shown[cap.ids.business]) : undefined;
  const payloadHash = computePayloadHash({
    module: doc.module, op: doc.op, recordId: targetDoc?.id ?? null, values, version: hashVersion(targetDoc, captured?.token),
  });
  const review = composeWorkflowReview({
    operationId: doc._id, revision, payloadHash, expiresAt, wf, cap, def, op, ctx,
    ...(targetDoc ? { target: targetRefOf(cap, targetDoc.id, number, label) } : {}),
    changes, shown, refs: stack.refs, warnings: stack.warnings, sideEffects: stack.sideEffects, editable: true, scopeKind: ctx.scope.kind,
    ...(spec ? {
      lines: lineRowsOf(stack.lines ?? state.lines, ctx.branchCurrency, state.from?.number), ...(stack.totals ? { totals: stack.totals } : {}),
    } : {}),
  });
  const staged = await casUpdate(doc, caller, 'draft', now, {
    status: 'staged', revision, payloadHash,
    sealed: seal({ ...draftSealed(sealed, state, stack, keptFrom(sourceOf(sealed.source.startedBy, captured?.token, label), sealed)), values, review }),
    fieldKeys: fieldKeysOf(values), ...(targetDoc ? { target: targetDoc } : {}),
    warnings: review.warnings, sideEffects: review.sideEffects, expiresAt, purgeAt: purgeAfter(expiresAt),
  });
  if (!staged) return staleReply(operationId, caller, now);
  await auditOperationStep(staged, 'staged');
  return { kind: 'review', operationId: doc._id, block: review, notices: [], confirmation: confirmationOf(cap, op, values, review) };
}

/** Edit on a review card (spec B12.5): the reviewed change goes back to its form (revision + 1, the draft's expiry)
 * and its hash is dropped, so that review can no longer be confirmed. A form already back answers as it is. */
export async function editStaged(operationId: string, body: { revision: number }, caller: WorkflowCaller): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  const { identity } = caller;
  const doc = await findOwned(operationId, identity, caller.sessionId);
  if (!doc) return missingReply(operationId, caller);
  if ((doc.branchId ?? null) !== (identity.branchId ?? null)) return refused(409, FORM_BRANCH_MESSAGE);
  const closed = await closedReply(doc, now);
  if (closed) return closed;
  const sealed = workflowSealedOf(doc);

  if (doc.status === 'draft') {
    if (!sealed) throw new Error('CRM assist: a draft without a guided form');
    const flow = await flowFor(doc, caller, now);
    if ('reply' in flow) return flow.reply;
    return { kind: 'form', operationId: doc._id, block: await renderDraft(flow, doc, sealed, caller), notices: [] };
  }

  // Staged: only a guided create or update has a form to go back to, and only the review the caller saw.
  if (!sealed || doc.op === 'delete') return refused(400, NOT_EDITABLE, reviewOf(doc));
  if (body.revision !== doc.revision) return refused(409, FORM_STALE, sealed.review);
  const flow = await flowFor(doc, caller, now);
  if ('reply' in flow) return flow.reply;
  const next: WorkflowSealed = { ...sealed };
  delete next.review;
  const revision = doc.revision + 1;
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS);
  const block = await renderDraft(flow, { ...doc, revision, expiresAt }, next, caller);
  const edited = await casUpdate(
    doc, caller, 'staged', now, { status: 'draft', revision, sealed: seal(next), expiresAt, purgeAt: purgeAfter(expiresAt) }, { payloadHash: 1 },
  );
  if (!edited) return staleReply(operationId, caller, now);
  await auditOperationStep(edited, 'edited');
  return { kind: 'form', operationId: doc._id, block, notices: [] };
}

/** Cancel (spec B12.6), in any branch: an open draft or review becomes cancelled, with its audit entry. One being
 * applied can't be cancelled any more; a closed one answers its result again. */
export async function cancelWorkflow(operationId: string, caller: WorkflowCaller): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  const { identity } = caller;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await findOwned(operationId, identity, caller.sessionId);
    if (!doc) return missingReply(operationId, caller);
    if (doc.status === 'executing') return resultReply(doc._id, plainOutcome(doc, 'unknown', CANT_CANCEL_NOW, false), doc);
    const closed = await closedReply(doc, now);
    if (closed) return closed;
    const cancelled = await transitionOperation(doc._id, doc.status, { status: 'cancelled', purgeAt: purgeAfter(now) }, {
      tenantId: identity.tenantId, userId: identity.userId, sessionId: caller.sessionId,
    });
    if (cancelled) {
      await auditOperationStep(cancelled, 'cancelled');
      return resultReply(doc._id, await outcomeOf(cancelled, false), cancelled);
    }
    // Lost a race (reviewed, edited, confirmed or expired meanwhile): look again.
  }
  return workflowStatus(operationId, caller);
}

/** Status (spec B12.7), in any branch: an open draft's form, an open review with its confirmation, or the result. */
export async function workflowStatus(operationId: string, caller: WorkflowCaller): Promise<WorkflowReply> {
  const now = caller.now ?? new Date();
  const doc = await findOwned(operationId, caller.identity, caller.sessionId);
  if (!doc) return missingReply(operationId, caller);
  const closed = await closedReply(doc, now);
  if (closed) return closed;

  if (doc.status === 'staged') {
    const sealed = unseal(doc.sealed);
    const cap = getModuleCap(doc.module);
    if (!sealed.review || !doc.payloadHash || !cap) throw new Error('CRM assist: a staged operation without its review');
    const confirmation = { ...confirmationOf(cap, doc.op, sealed.values, sealed.review), revision: doc.revision, payloadHash: doc.payloadHash };
    return { kind: 'review', operationId: doc._id, block: sealed.review, notices: [], confirmation };
  }

  const sealed = workflowSealedOf(doc);
  if (!sealed) throw new Error('CRM assist: a draft without a guided form');
  // From any company, the form as its own company shows it (its custom fields, defaults and full form, L27), never
  // the caller's current one. Nothing is written.
  const owner: WorkflowCaller = { ...caller, identity: { ...caller.identity, branchId: doc.branchId ?? null } };
  const flow = await flowFor(doc, owner, now);
  if ('reply' in flow) return flow.reply;
  return { kind: 'form', operationId: doc._id, block: await renderDraft(flow, doc, sealed, owner), notices: [] };
}

/** The open form's fields for the fill reader: draft or staged, owner only. */
export async function formSpecFor(operationId: string, caller: WorkflowCaller): Promise<FillFormSpec | null> {
  const now = caller.now ?? new Date();
  const doc = await findOwned(operationId, caller.identity, caller.sessionId);
  if (!doc || (doc.status !== 'draft' && doc.status !== 'staged') || doc.op === 'delete') return null;
  if (new Date(doc.expiresAt).getTime() <= now.getTime()) return null;
  const wf = workflowModuleFor(doc.module);
  const sealed = wf ? workflowSealedOf(doc) : null;
  if (!wf || !sealed) return null;
  const ctx = await loadFormContext(wf, doc.op, { identity: caller.identity, tenant: caller.tenant, now });
  return formSpecOf(fieldsFor(wf, doc.op, ctx), sealed.form, doc.op, doc.module);
}
