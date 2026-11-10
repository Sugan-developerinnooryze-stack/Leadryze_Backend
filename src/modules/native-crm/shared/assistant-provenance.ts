/**
 * CRM-assistant reminder pause.
 *
 * Customer-facing reminders (scheduler/crm-reminders.scheduler.ts) and
 * on-create confirmations (notifications/confirmation.service.ts) are never
 * sent with reminder data written through the internal CRM assistant
 * (POST /api/internal/crm-write) until someone else has changed that data.
 *
 * Markers: server-managed and internal only. They have no schema default (a
 * marker is absent unless the record was paused) and are `select: false`, so a
 * query only sees them when it asks with assistantMarkerSelect(). The schemas'
 * toJSON/toObject transforms drop them. As a result, screen API responses,
 * CRM change-log snapshots, the search index and the gateway never carry them.
 * - assistantChangedAt: when the assistant paused the record.
 * - assistantFingerprint: reminderFingerprint() of the record's
 *   REMINDER_RELEVANT_FIELDS right after that write.
 * - reminderSuppressedAt (Call/Task only): the reminder cron already logged
 *   "not sent" for the current pause, so the skip is logged once per pause.
 *
 * Pause rule:
 * - A chat write pauses the record only when it creates the record or changes
 *   at least one reminder-relevant field, compared with the record the gateway
 *   loaded before the write. The written values are compared as Mongoose will
 *   store them (reminderValueCaster). When the change cannot be worked out
 *   (no loaded record, an operator other than $set/$unset on a relevant field,
 *   a multi-record update, a value that cannot be cast), the record is paused
 *   with no fingerprint. Pausing sets assistantChangedAt and
 *   assistantFingerprint, and clears reminderSuppressedAt, in the SAME database
 *   write (the hooks below, inside the gateway's runAsAssistantWrite()
 *   context). A chat write of other fields leaves the markers exactly as they
 *   are.
 * - A record is paused while it is stamped AND its current fingerprint equals
 *   the stored one: its reminder data is still exactly what the assistant
 *   wrote. A screen edit of other fields, or a screen re-save of identical
 *   values, changes nothing. Once the fingerprint differs, someone else has
 *   changed that data, so the record counts as human-confirmed and the normal
 *   reminder rules decide. Nothing clears the markers on a screen edit; the
 *   decision is re-made from the record's own values every time
 *   (evaluateAssistantPause()).
 * - The pause is per record, not per field. A human change to ANY
 *   reminder-relevant field confirms the whole record, so the reminder then
 *   carries the record's current values, including the ones the assistant
 *   wrote and the human left as they were. Examples: a human links an
 *   assistant-created task to a customer, and the customer gets the
 *   assistant's title and time; a human corrects only the contact name of a
 *   call whose time the assistant moved, and the reminder carries the
 *   assistant's time. A per-field pause was not used because a person can
 *   only confirm a field by changing it: the screen edit form sends every
 *   field on each save, so a re-save cannot be told apart from looking at a
 *   field and keeping it. A per-field pause would therefore keep a correct
 *   assistant value silent until someone changed it.
 * - Only the gateway context can set the markers. Every other write has marker
 *   writes stripped; before that, the screen Zod schemas and the gateway
 *   allowlist already reject them. Reminder bookkeeping
 *   (runAsReminderBookkeeping) may write reminderSuppressedAt only.
 *
 * Kept free of other app imports so the schema files can use it without
 * creating import cycles.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { Schema } from 'mongoose';

export const ASSISTANT_CHANGED_AT = 'assistantChangedAt';
export const ASSISTANT_FINGERPRINT = 'assistantFingerprint';
export const REMINDER_SUPPRESSED_AT = 'reminderSuppressedAt';

/** Every server-managed marker key. Ticket has no reminderSuppressedAt. */
export const ASSISTANT_MARKER_KEYS: readonly string[] = Object.freeze([
  ASSISTANT_CHANGED_AT, ASSISTANT_FINGERPRINT, REMINDER_SUPPRESSED_AT,
]);

/** EmailLog `errorMessage` for a reminder the cron did not send. */
export const ASSISTANT_REMINDER_SKIP_REASON =
  'Not sent: this record was last changed through the CRM assistant; customer reminders are only sent for changes made in the app screens.';

/** EmailLog `errorMessage` for an on-create confirmation that was not sent. */
export const ASSISTANT_CONFIRMATION_SKIP_REASON =
  'Not sent: this record was created through the CRM assistant; customer confirmations are only sent for records created in the app screens.';

/** Registry modules the assistant can create/update whose records feed a
 * customer reminder or confirmation. */
export type AssistantPausedModule = 'call' | 'task' | 'ticket';

/**
 * Per module, the record fields that decide whether, when, to whom or with
 * what content a customer reminder or confirmation is sent. The fingerprint
 * covers exactly these fields.
 *
 * call: reminder cron (runCallMeetingReminders/sendReminder) and on-create
 * confirmation (sendOnCreateConfirmation)
 * - date: the cron's query window and tolerance check; the "when" in the
 *   reminder and in the confirmation (whenFmt).
 * - callStatus: the cron only selects 'planned'. The confirmation skips
 *   completed/missed/cancelled (isPastOrInactiveStatus).
 * - contactName: the reminder and confirmation title.
 * - relatedModule, relatedId: the cron only selects linked records. They are
 *   also the recipient (resolveRecipient) and the confirmation's link check.
 * - Not relevant: direction, notes, tags, customFields, relatedLabel (only in
 *   our own EmailLog rows, never in a message). Also not relevant: duration
 *   and timezone. Only the on-create confirmation reads those, once, on create,
 *   and a chat create is always paused.
 *
 * task: reminder cron only. Tasks never get a confirmation; that function
 * returns first for 'task'.
 * - dueDate: query window, tolerance check and the "when".
 * - taskStatus: the cron skips done/cancelled.
 * - title: the reminder title.
 * - relatedModule, relatedId: the link filter and the recipient.
 * - Not relevant: priority, assignedTo (no send path reads it), notes, tags,
 *   customFields, relatedLabel.
 *
 * ticket: on-create confirmation only. There is no ticket reminder.
 * - ticketStatus: resolved/closed is skipped (isPastOrInactiveStatus).
 * - subject: the confirmation title.
 * - relatedModule, relatedId: the link check and the recipient.
 * - Not relevant: priority, description, contactName (never in a message),
 *   and branchId. branchId only picks a timezone, which a ticket confirmation
 *   never prints because whenFmt has no ticket date.
 */
export const REMINDER_RELEVANT_FIELDS: Readonly<Record<AssistantPausedModule, readonly string[]>> = Object.freeze({
  call:   Object.freeze(['date', 'callStatus', 'contactName', 'relatedModule', 'relatedId']),
  task:   Object.freeze(['dueDate', 'taskStatus', 'title', 'relatedModule', 'relatedId']),
  ticket: Object.freeze(['ticketStatus', 'subject', 'relatedModule', 'relatedId']),
});

/** The status fields' schema defaults. They are also the values
 * isPastOrInactiveStatus assumes for a missing status, so a missing status and
 * its default fingerprint the same. */
export const REMINDER_STATUS_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  callStatus: 'planned', taskStatus: 'todo', ticketStatus: 'open',
});

const DATE_FIELDS: ReadonlySet<string> = new Set(['date', 'dueDate']);

/** Mongoose's own Date caster, the one a write uses. A date written as a
 * string and the same date read back from the database fingerprint the same. */
const castDate = Schema.Types.Date.cast() as unknown as (value: unknown) => Date | null;

export function isAssistantPausedModule(module: string): module is AssistantPausedModule {
  return Object.prototype.hasOwnProperty.call(REMINDER_RELEVANT_FIELDS, module);
}

/** One reminder-relevant value, normalised. Dates become ISO strings. ObjectIds
 * become hex. Strings are trimmed, since the schema trims them on write. A
 * missing or empty value becomes null, or the status default for a status
 * field. */
export function normaliseReminderValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return REMINDER_STATUS_DEFAULTS[field] ?? null;
  if (DATE_FIELDS.has(field)) {
    try {
      const date = castDate(value);
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
    } catch {
      return `unparseable:${String(value)}`;
    }
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'object' && typeof (value as { toHexString?: unknown }).toHexString === 'function') {
    return (value as { toHexString: () => string }).toHexString();
  }
  const text = String(value).trim();
  return text === '' ? (REMINDER_STATUS_DEFAULTS[field] ?? null) : text;
}

/** Stable hash of a record's normalised REMINDER_RELEVANT_FIELDS. Works on a
 * lean object, a plain object and a Mongoose document (getters). */
export function reminderFingerprint(module: AssistantPausedModule, record: unknown): string {
  const source = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;
  const values = REMINDER_RELEVANT_FIELDS[module].map((field) => [field, normaliseReminderValue(field, source[field])]);
  return `v1:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

export interface AssistantPauseState {
  /** True while customer reminders/confirmations must not be sent. */
  paused: boolean;
  /** The pause's assistantChangedAt, or null when the record was never paused. */
  stamp: unknown;
  reason: 'not-stamped' | 'assistant-data-unchanged' | 'no-fingerprint' | 'changed-since-assistant';
}

/** Decides from the record's own current values (which must include the
 * markers) whether it is paused. A stamp without a usable fingerprint stays
 * paused. That covers stamps from before fingerprints existed, a write whose
 * values could not be computed, and a module without relevant fields. */
export function evaluateAssistantPause(module: string, record: unknown): AssistantPauseState {
  const source = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;
  const stamp = source[ASSISTANT_CHANGED_AT];
  if (stamp === undefined || stamp === null || stamp === '') return { paused: false, stamp: null, reason: 'not-stamped' };
  const stored = source[ASSISTANT_FINGERPRINT];
  if (typeof stored !== 'string' || !stored || !isAssistantPausedModule(module)) {
    return { paused: true, stamp, reason: 'no-fingerprint' };
  }
  return reminderFingerprint(module, source) === stored
    ? { paused: true, stamp, reason: 'assistant-data-unchanged' }
    : { paused: false, stamp, reason: 'changed-since-assistant' };
}

/** `.select()` argument that adds the model's (select:false) markers to a
 * query. Use it only where the markers are needed: the reminder cron and the
 * confirmation backstop. */
export function assistantMarkerSelect(schema: Schema): string {
  return ASSISTANT_MARKER_KEYS.filter((key) => !!schema.path(key)).map((key) => `+${key}`).join(' ');
}

const topLevel = (path: string): string => path.split('.')[0];

/** A shallow copy without marker keys (or dotted keys under them). For data
 * that never went through a schema, e.g. search-index hits. */
export function withoutAssistantMarkers<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!ASSISTANT_MARKER_KEYS.includes(topLevel(key))) out[key] = value;
  }
  return out as T;
}

/* ── Write context ──────────────────────────────────────────────────── */

interface AssistantWriteStore {
  kind: 'assistant';
  module: AssistantPausedModule;
  at: Date;
  /** The record before an update (the gateway's `current`); null on create. */
  before: Record<string, unknown> | null;
  /** One gateway write is one record write. Once the first write of `module`'s
   * model in this context is decided, later writes in the same async context
   * (deferred work) are treated like any other write. */
  claimed: boolean;
  /** Records this context paused on create, for the confirmation backstop. */
  paused: Map<string, { at: Date; fingerprint: string }>;
}
interface ReminderBookkeepingStore { kind: 'reminder-bookkeeping' }

const provenanceContext = new AsyncLocalStorage<AssistantWriteStore | ReminderBookkeepingStore>();

/** Runs `fn` as the CRM assistant gateway's create/update of one `module`
 * record. `before` is that record as the gateway loaded it (null on create).
 * Called only by the gateway (crm-gateway.helpers.ts dispatchAssistantWrite). */
export function runAsAssistantWrite<T>(
  module: AssistantPausedModule, before: Record<string, unknown> | null, fn: () => Promise<T>, at?: Date,
): Promise<T> {
  return provenanceContext.run(
    { kind: 'assistant', module, at: at ?? new Date(), before: before ?? null, claimed: false, paused: new Map() },
    fn,
  );
}

/** Runs `fn` as reminder bookkeeping. Its writes may set
 * reminderSuppressedAt, and no other marker. */
export function runAsReminderBookkeeping<T>(fn: () => Promise<T>): Promise<T> {
  return provenanceContext.run({ kind: 'reminder-bookkeeping' }, fn);
}

/** The assistant write in progress, or undefined outside one. */
export function currentAssistantWrite(): { module: AssistantPausedModule; at: Date } | undefined {
  const store = provenanceContext.getStore();
  return store?.kind === 'assistant' ? { module: store.module, at: store.at } : undefined;
}

/** The markers the assistant write in progress gave this record when it
 * created it, or undefined. */
export function assistantPauseInCurrentWrite(module: string, recordId: string): { at: Date; fingerprint: string } | undefined {
  const store = provenanceContext.getStore();
  return store?.kind === 'assistant' && store.module === module ? store.paused.get(recordId) : undefined;
}

function claimAssistantWrite(module: AssistantPausedModule): AssistantWriteStore | undefined {
  const store = provenanceContext.getStore();
  if (store?.kind !== 'assistant' || store.module !== module || store.claimed) return undefined;
  store.claimed = true;
  return store;
}

function inReminderBookkeeping(): boolean {
  return provenanceContext.getStore()?.kind === 'reminder-bookkeeping';
}

/* ── Update documents ───────────────────────────────────────────────── */

type UpdateDoc = Record<string, any>;

/** Removes every write of `keys` from an update: an implicit set, any
 * operator, or a $rename to or from them. Operator objects are copied before
 * being changed, so the caller's objects are never mutated. Returns true when
 * something was removed. */
export function stripMarkerWrites(update: UpdateDoc, keys: readonly string[]): boolean {
  const blocked = new Set(keys);
  let removed = false;
  for (const key of Object.keys(update)) {
    if (!key.startsWith('$')) {
      if (blocked.has(topLevel(key))) { delete update[key]; removed = true; }
      continue;
    }
    const op = update[key];
    if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
    const hits = Object.entries(op).filter(([path, value]) =>
      blocked.has(topLevel(path)) || (key === '$rename' && typeof value === 'string' && blocked.has(topLevel(value))));
    if (hits.length === 0) continue;
    const kept = { ...op };
    for (const [path] of hits) delete kept[path];
    if (Object.keys(kept).length === 0) delete update[key]; else update[key] = kept;
    removed = true;
  }
  return removed;
}

export interface AssistantUpdateDecision {
  pause: boolean;
  /** The fingerprint after the write. Null when it cannot be computed from
   * `before` + the update (no `before`, a non-$set operator on a relevant
   * field, a multi-record update, or a value the caster rejects). The record
   * then stays paused until the assistant changes a relevant field again. */
  fingerprint: string | null;
}

/** Turns a value written to `field` into the value the database will hold.
 * Throws when the value cannot be stored as that field's type. */
export type ReminderValueCaster = (field: string, value: unknown) => unknown;

/** The cast Mongoose itself applies to a `$set` of `field` in an update
 * (castUpdate -> SchemaType.castForQuery: the path's setters, such as trim,
 * then its type's caster). It matters because the JSON shape of a value is
 * not always what gets stored: a String path stores `{ _id: 'text' }` as
 * 'text' (mongoose/lib/cast/string.js). A field the schema does not have
 * throws, so the update counts as unknown. */
export function reminderValueCaster(schema: Schema, context?: unknown): ReminderValueCaster {
  return (field, value) => {
    const path = schema.path(field) as unknown as { castForQuery?: (conditional: null, val: unknown, ctx: unknown) => unknown } | undefined;
    if (!path || typeof path.castForQuery !== 'function') throw new Error(`no schema path "${field}"`);
    return path.castForQuery(null, value, context);
  };
}

/** Used when no schema caster is given: a scalar is taken as it is, and a
 * list or a plain object (whose stored form depends on the schema) throws. */
const scalarOnlyCaster: ReminderValueCaster = (_field, value) => {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)
      && typeof (value as { toHexString?: unknown }).toHexString !== 'function') {
    throw new Error('not a single value');
  }
  return value;
};

/** For "did this write change it?" only. Same as normaliseReminderValue, except
 * that a missing or empty status is not treated as its default. The reminder
 * cron selects calls by callStatus 'planned' exactly, so writing the default
 * onto a record that has no status can make it due for a reminder. That
 * counts as a change. */
function changeKey(field: string, value: unknown): string | null {
  if (field in REMINDER_STATUS_DEFAULTS && (value === undefined || value === null || String(value).trim() === '')) return null;
  return normaliseReminderValue(field, value);
}

/** Whether a gateway update pauses the record: only when it changes at least
 * one reminder-relevant field compared with `before`. Each written value is
 * first turned into the value the database will hold (`castValue`; the model
 * hook passes reminderValueCaster, Mongoose's own update cast), so the change
 * test and the fingerprint use exactly what gets stored. A value the caster
 * rejects makes the update unknown: paused, with no fingerprint. */
export function decideAssistantUpdate(
  module: AssistantPausedModule, before: Record<string, unknown> | null, update: UpdateDoc, multi = false,
  castValue: ReminderValueCaster = scalarOnlyCaster,
): AssistantUpdateDecision {
  const relevant = new Set(REMINDER_RELEVANT_FIELDS[module]);
  const written = new Map<string, unknown>();
  let opaque = false;
  // Mongoose drops a set to `undefined` from an update (castUpdate), so it
  // writes nothing. Only $unset removes a field.
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      const field = topLevel(key);
      if (relevant.has(field)) { if (key !== field) opaque = true; else if (value !== undefined) written.set(field, value); }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [path, opValue] of Object.entries(value as Record<string, unknown>)) {
      const field = topLevel(path);
      if (key === '$rename') {
        if (relevant.has(field) || (typeof opValue === 'string' && relevant.has(topLevel(opValue)))) opaque = true;
        continue;
      }
      if (!relevant.has(field) || key === '$setOnInsert') continue; // $setOnInsert only applies to an upsert insert
      if (path !== field) opaque = true;
      else if (key === '$set') { if (opValue !== undefined) written.set(field, opValue); }
      else if (key === '$unset') written.set(field, undefined);
      else opaque = true;
    }
  }
  if (written.size === 0 && !opaque) return { pause: false, fingerprint: null };
  if (opaque || multi || !before) return { pause: true, fingerprint: null };
  const after: Record<string, unknown> = { ...before };
  for (const [field, value] of written) {
    if (value === undefined) { after[field] = undefined; continue; } // $unset
    try {
      after[field] = castValue(field, value);
    } catch {
      return { pause: true, fingerprint: null };
    }
  }
  const changed = [...written.keys()].some((field) => changeKey(field, after[field]) !== changeKey(field, before[field]));
  if (!changed) return { pause: false, fingerprint: null };
  return { pause: true, fingerprint: reminderFingerprint(module, after) };
}

/** Adds a pause to an update. Implicit fields move into $set, which Mongoose
 * does itself anyway. */
function addPauseToUpdate(update: UpdateDoc, at: Date, fingerprint: string | null, hasSuppressedMarker: boolean): void {
  const implicit = Object.keys(update).filter((key) => !key.startsWith('$'));
  const $set: Record<string, unknown> = { ...(update.$set ?? {}) };
  for (const key of implicit) { $set[key] = update[key]; delete update[key]; }
  $set[ASSISTANT_CHANGED_AT] = at;
  if (fingerprint) $set[ASSISTANT_FINGERPRINT] = fingerprint;
  update.$set = $set;
  const $unset: Record<string, unknown> = {};
  if (!fingerprint) $unset[ASSISTANT_FINGERPRINT] = 1;
  if (hasSuppressedMarker) $unset[REMINDER_SUPPRESSED_AT] = 1;
  if (Object.keys($unset).length > 0) update.$unset = { ...(update.$unset ?? {}), ...$unset };
}

/* ── Schema registration ────────────────────────────────────────────── */

type Transform = (doc: unknown, ret: Record<string, unknown>, options: unknown) => unknown;

/** toJSON/toObject drop the markers, keeping any transform already set. */
function hideMarkersFromSerialisation(schema: Schema, keys: readonly string[]): void {
  for (const option of ['toJSON', 'toObject'] as const) {
    const existing = (schema.get(option) ?? {}) as Record<string, unknown>;
    const previous = typeof existing.transform === 'function' ? existing.transform as Transform : undefined;
    const transform: Transform = (doc, ret, options) => {
      const out = previous ? previous(doc, ret, options) : undefined;
      const target = out === undefined ? ret : out;
      if (target && typeof target === 'object') for (const key of keys) delete (target as Record<string, unknown>)[key];
      return target;
    };
    schema.set(option, { ...existing, transform } as never);
  }
}

/** Registers the marker hooks and serialisation transforms on a schema that
 * declares the markers. Covers every write path the services and the reminder
 * cron use: Model.create / doc.save, findOneAndUpdate (including
 * findByIdAndUpdate), updateOne and updateMany. */
export function registerAssistantProvenanceHooks(schema: Schema, module: AssistantPausedModule): void {
  const markerKeys = ASSISTANT_MARKER_KEYS.filter((key) => !!schema.path(key));
  const hasSuppressedMarker = markerKeys.includes(REMINDER_SUPPRESSED_AT);
  const relevant = REMINDER_RELEVANT_FIELDS[module];
  hideMarkersFromSerialisation(schema, markerKeys);

  schema.pre('save', function () {
    const doc = this as any;
    const bookkeeping = inReminderBookkeeping();
    const ctx = claimAssistantWrite(module);
    // Server-managed: whatever a caller put on the markers is dropped first.
    for (const key of markerKeys) {
      if (bookkeeping && key === REMINDER_SUPPRESSED_AT) continue;
      if (doc.isNew) { if (doc.get(key) !== undefined) doc.set(key, undefined); } else if (doc.isModified(key)) doc.unmarkModified(key);
    }
    if (!ctx) return;
    // A gateway create always pauses. A gateway save of an existing record
    // pauses only when a relevant field really changed (Mongoose marks a
    // path modified only when its value changes).
    if (!doc.isNew && !relevant.some((field) => doc.isModified(field))) return;
    const fingerprint = reminderFingerprint(module, doc);
    doc.set(ASSISTANT_CHANGED_AT, ctx.at);
    doc.set(ASSISTANT_FINGERPRINT, fingerprint);
    if (hasSuppressedMarker) doc.set(REMINDER_SUPPRESSED_AT, undefined);
    ctx.paused.set(String(doc._id), { at: ctx.at, fingerprint });
  });

  schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    const update = this.getUpdate() as UpdateDoc | null;
    if (!update || Array.isArray(update)) return; // pipeline updates are never used for these models
    const bookkeeping = inReminderBookkeeping();
    let changed = stripMarkerWrites(update, bookkeeping ? markerKeys.filter((key) => key !== REMINDER_SUPPRESSED_AT) : markerKeys);
    const ctx = claimAssistantWrite(module);
    if (ctx) {
      const decision = decideAssistantUpdate(
        module, ctx.before, update, (this as { op?: string }).op === 'updateMany', reminderValueCaster(schema, this),
      );
      if (decision.pause) {
        addPauseToUpdate(update, ctx.at, decision.fingerprint, hasSuppressedMarker);
        changed = true;
      }
    }
    if (changed) this.setUpdate(update);
  });
}
