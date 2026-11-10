import type { RefInput } from '../contracts/plan';
import type { EntityChoice } from '../contracts/views';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteFormField, WriteRelatedSpec } from '../registry/types';
import type { ExecContext } from '../query/execute-list';
import { EntityMatch, MAX_ENTITY_MATCHES, recentEntities, resolveEntity } from '../query/resolve-entity';
import { ScopeFailClosedError, idCondition, isObjectIdText } from '../query/scoped-match';
import type { RefDeps, RefResolution, StoredRef, StoredRefValue } from '../writes/workflow-types';
import { crmUserRef, lookupCrmUsers } from './crm-users';
import { logger } from '../../../utils/logger';

/* References on a guided form (Increment 6, B-REF): a record named in words
 * (or by one of its own record numbers), by an id the server wrote (a
 * candidate, a picker, a record action), the record on screen, or "me".
 *
 * Every read runs under the referenced module's own gates and scope
 * (deps.gate, which is gateRelated) and goes through resolve-entity.ts; a
 * refused gate is a refusal, never an unscoped read. Deal, contact and
 * company have no record numbers, so they are only ever found by name or by
 * a 24-hex _id: their clientId (the tenant prefix every record shares) and a
 * 12-character id never name anything.
 *
 * A child field is narrowed by its parent on the same form (a site within
 * the customer's _id, staff within the team's _id), from the parent's
 * server-resolved ref only. A typed name picks its record only when exactly
 * one visible record has that whole name and nothing else matches (L30);
 * otherwise the picker offers the candidates. What is stored is the
 * referenced record's own key from the scoped read (its number, its _id, a
 * user id), never the text typed. Review and commit re-read every stored ref
 * by _id under the current scope (recheckRefs). Typed text is never logged. */

type Refusal = Extract<RefResolution, { state: 'refused' }>['reason'];
/** RefDeps without `resolved`; resolveFieldRefs also takes the form's earlier refs (`resolved`), so a
 * fill that names only a site is narrowed by the customer already on the form. */
type BatchDeps = Omit<RefDeps, 'resolved'> & { resolved?: RefDeps['resolved'] };

const REF_GONE = 'This record is gone or no longer visible to you. Pick another.';
const SITE_OTHER_CUSTOMER = 'This site belongs to another customer.';
/** A child picked only once its parent is (B9): a site always goes with a customer, as the screen's
 * site list waits for one. Staff without a team are picked from every staff member the caller can see. */
const PARENT_FIRST: Readonly<Record<string, string>> = Object.freeze({ site: 'Pick a customer first.' });
/** The owner module's key in a StoredRef and an EntityChoice. */
const USER_MODULE = 'user';
/** The longest text a name search reads (as resolve-entity.ts reads it). */
const MAX_NAME_TEXT = 100;
/** A list field (staffIds) resolves at most this many records at once (FORM_CAPS.multi). */
const MAX_MANY = 10;
/** A record id as text (scoped-match.ts isObjectIdText, without its type narrowing). */
const HEX_ID = /^[a-f0-9]{24}$/i;

const refused = (module: string, reason: Refusal): RefResolution => ({ state: 'refused', module, reason });
const notFound = (module: string, text: string | null): RefResolution => ({ state: 'not_found', module, text });
const has = (record: Readonly<Record<string, unknown>>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** Text as the name search reads it: one space between words, trimmed, at most MAX_NAME_TEXT characters. */
function cleanText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_TEXT) : '';
}

/** Whether a match is named by the whole text: its name as shown, or its record number as shown, in any case. */
function isWholeName(match: { label: string; number?: string }, text: string): boolean {
  const want = cleanText(text).toLowerCase();
  return cleanText(match.label).toLowerCase() === want || (!!match.number && cleanText(match.number).toLowerCase() === want);
}

/** A stored key as text: a string as stored, a number, an ObjectId as its hex. */
function keyText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    const hex = String(value);
    return isObjectIdText(hex) ? hex.toLowerCase() : null;
  }
  return null;
}

/** Text a person may read as a label: never a record id. */
function labelText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || HEX_ID.test(t)) return null;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function isRefField(field: WriteFormField): boolean {
  return ((field.kind === 'ref' || field.kind === 'ref_many') && !!field.ref) || (field.kind === 'related' && !!field.related)
    || field.kind === 'owner_user';
}

/** The module a refusal or a "not found" names for this field: its referenced module, a related
 * field's first module (the form's default choice), or the owner module. */
function defaultModuleOf(field: WriteFormField): string {
  if (field.kind === 'owner_user') return USER_MODULE;
  return field.ref?.module ?? field.related?.modules[0] ?? field.key;
}

/** What a related record is referred to by in this module: its _id, or (activity) its record number. */
function relatedKeyPath(spec: WriteRelatedSpec, cap: ModuleCap): string | null {
  return spec.store === 'objectId' ? '_id' : cap.ids.business ?? null;
}

function storedOf(module: string, match: EntityMatch): StoredRef {
  return { module, id: match.id, key: match.key, label: match.label, ...(match.number ? { number: match.number } : {}) };
}

function choiceOf(cap: ModuleCap, match: EntityMatch): EntityChoice {
  return {
    module: cap.key, id: match.id, label: match.label, source: cap.group,
    ...(match.number ? { number: match.number } : {}), ...(match.detail ? { detail: match.detail } : {}),
  };
}

/* ── Narrowing by the parent field (within) ───────────────────────────── */

type Within =
  | { ok: true; extra: Record<string, unknown>[]; parent: StoredRef | null }
  /** no_parent: none picked and this child needs one; hidden: one the caller can't see (or several), so nothing can be checked against it. */
  | { ok: false; why: 'no_parent' | 'hidden'; parent: StoredRefValue | null };

/** The extra condition narrowing a child to its parent on the same form ({ [childPath]: the parent's
 * _id }), built only from the parent's server-resolved ref. No parent picked: no narrowing, except
 * for a child that needs one (PARENT_FIRST). */
function withinFor(field: WriteFormField, resolved: Readonly<Record<string, StoredRefValue | undefined>>): Within {
  const within = field.ref?.within;
  if (!within) return { ok: true, extra: [], parent: null };
  const parent = has(resolved, within.field) ? resolved[within.field] : undefined;
  if (parent === undefined || parent === null) {
    return has(PARENT_FIRST, field.ref!.module) ? { ok: false, why: 'no_parent', parent: null } : { ok: true, extra: [], parent: null };
  }
  if (Array.isArray(parent) || !isObjectIdText(parent.id)) return { ok: false, why: 'hidden', parent };
  return { ok: true, extra: [idCondition(within.childPath, [parent.id])], parent };
}

/** The error for a stored child its parent no longer holds (B20). */
function outsideParentText(field: WriteFormField, stored: StoredRef, parent: StoredRefValue | null): string {
  if (field.ref?.module === 'site') return SITE_OTHER_CUSTOMER;
  if (field.ref?.module === 'staff') {
    const team = parent && !Array.isArray(parent) ? parent.label : '';
    return team ? `${stored.label} isn't in team ${team}.` : `${stored.label} isn't in the team picked.`;
  }
  return REF_GONE;
}

/* ── One record, under its module's gates and scope ───────────────────── */

/** L30: picked only when exactly one usable record matched and it has the whole name; several, or one
 * that only contains the text, give the candidates; none gives not_found. A record without the key a
 * reference stores can't be picked. */
function pickFrom(module: string, text: string, found: Array<{ cap: ModuleCap; match: EntityMatch }>, more: boolean): RefResolution {
  const usable = found.filter((f) => !!f.match.key);
  if (!usable.length) return notFound(module, text);
  const only = found.length === 1 && !more ? usable[0] : null;
  if (only && isWholeName(only.match, text)) return { state: 'resolved', ref: storedOf(only.cap.key, only.match) };
  return {
    state: 'ambiguous', module, text,
    candidates: usable.slice(0, MAX_ENTITY_MATCHES).map((f) => choiceOf(f.cap, f.match)),
    more: more || usable.length > MAX_ENTITY_MATCHES,
  };
}

/** A record by its _id: visible under scope and within its parent. Visible but not within gives
 * outside_parent; not visible (or not an id) gives bad_id. */
async function byRef(cap: ModuleCap, ctx: ExecContext, id: string, keyPath: string, extra: Record<string, unknown>[]): Promise<RefResolution> {
  if (!isObjectIdText(id)) return refused(cap.key, 'bad_id');
  const match = (await resolveEntity(cap, { ref: id }, ctx, { keyPath, extra })).matches[0];
  if (match) return match.key ? { state: 'resolved', ref: storedOf(cap.key, match) } : refused(cap.key, 'bad_id');
  if (extra.length && (await resolveEntity(cap, { ref: id }, ctx, { keyPath })).matches.length) return refused(cap.key, 'outside_parent');
  return refused(cap.key, 'bad_id');
}

/** The record on screen, only when it belongs to this module; one the caller can't see is not found. */
async function byFocus(
  cap: ModuleCap, ctx: ExecContext, focus: RefDeps['focus'], keyPath: string, extra: Record<string, unknown>[],
): Promise<RefResolution> {
  if (!focus || focus.module !== cap.key) return notFound(cap.key, null);
  const found = await byRef(cap, ctx, focus.id, keyPath, extra);
  return found.state === 'refused' && found.reason === 'bad_id' ? notFound(cap.key, null) : found;
}

async function byText(cap: ModuleCap, ctx: ExecContext, text: string, keyPath: string, extra: Record<string, unknown>[]): Promise<RefResolution> {
  const t = cleanText(text);
  if (!t) return notFound(cap.key, null);
  // Escaped exactly once, by resolve-entity.ts; never here.
  const found = await resolveEntity(cap, { text: t }, ctx, { keyPath, limit: MAX_ENTITY_MATCHES, extra });
  return pickFrom(cap.key, t, found.matches.map((match) => ({ cap, match })), found.more);
}

/** ref and ref_many: one record of field.ref.module. */
async function resolveRecord(field: WriteFormField, input: RefInput, deps: RefDeps): Promise<RefResolution> {
  const spec = field.ref!;
  const module = spec.module;
  if ('me' in input) {
    // "Me" is the caller's own staff profile, on a staff field only; it is re-read like any other pick.
    if (module !== 'staff') return refused(module, 'bad_id');
    if (!deps.ctx.ownStaff) return refused(module, 'no_permission');
    return resolveRecord(field, { ref: deps.ctx.ownStaff.id }, deps);
  }
  if ('ref' in input && input.module !== undefined && input.module !== module) return refused(module, 'bad_id');
  const side = await deps.gate(module);
  if (!side.ok) return refused(module, side.reason);
  const within = withinFor(field, deps.resolved ?? {});
  if (!within.ok) return refused(module, 'outside_parent');
  try {
    if ('text' in input) return await byText(side.cap, side.ctx, input.text, spec.targetField, within.extra);
    if ('ref' in input) return await byRef(side.cap, side.ctx, input.ref, spec.targetField, within.extra);
    return await byFocus(side.cap, side.ctx, deps.focus, spec.targetField, within.extra);
  } catch (err) {
    if (err instanceof ScopeFailClosedError) return refused(module, 'scope_failed');
    throw err;
  }
}

/** related: one record of one of field.related.modules. Typed text is looked for in each of them the
 * caller can read (one read each); an id needs its module. */
async function resolveRelated(field: WriteFormField, input: RefInput, deps: RefDeps): Promise<RefResolution> {
  const spec = field.related!;
  const fallback = defaultModuleOf(field);
  if ('me' in input) return refused(fallback, 'bad_id');
  const one = async (module: string, run: (cap: ModuleCap, ctx: ExecContext, keyPath: string) => Promise<RefResolution>): Promise<RefResolution> => {
    if (!spec.modules.includes(module)) return refused(module, 'unknown_module');
    const side = await deps.gate(module);
    if (!side.ok) return refused(module, side.reason);
    const keyPath = relatedKeyPath(spec, side.cap);
    if (!keyPath) return refused(module, 'unknown_module');
    try {
      return await run(side.cap, side.ctx, keyPath);
    } catch (err) {
      if (err instanceof ScopeFailClosedError) return refused(module, 'scope_failed');
      throw err;
    }
  };
  if ('ref' in input) {
    if (!input.module) return refused(fallback, 'bad_id');
    return one(input.module, (cap, ctx, keyPath) => byRef(cap, ctx, input.ref, keyPath, []));
  }
  if ('focus' in input) {
    const focus = deps.focus;
    if (!focus || !spec.modules.includes(focus.module)) return notFound(fallback, null);
    return one(focus.module, (cap, ctx, keyPath) => byFocus(cap, ctx, focus, keyPath, []));
  }

  const t = cleanText(input.text);
  if (!t) return notFound(fallback, null);
  const sides = await Promise.all(spec.modules.map(async (module) => ({ module, side: await deps.gate(module) })));
  const readable = sides.flatMap(({ module, side }) => {
    const keyPath = side.ok ? relatedKeyPath(spec, side.cap) : null;
    return side.ok && keyPath ? [{ module, cap: side.cap, ctx: side.ctx, keyPath }] : [];
  });
  if (!readable.length) {
    const first = sides.find((s) => !s.side.ok);
    return refused(first?.module ?? fallback, first && !first.side.ok ? first.side.reason : 'unknown_module');
  }
  const reads = await Promise.all(readable.map(async (r) => {
    try {
      return { cap: r.cap, found: await resolveEntity(r.cap, { text: t }, r.ctx, { keyPath: r.keyPath, limit: MAX_ENTITY_MATCHES, oneRead: true }) };
    } catch (err) {
      if (err instanceof ScopeFailClosedError) return null;
      throw err;
    }
  }));
  const done = reads.filter((r): r is NonNullable<typeof r> => r !== null);
  const module = readable[0].module;
  if (!done.length) return refused(module, 'scope_failed');
  // Across modules, the records named exactly so are offered first (each module's list is newest first).
  const found = done.flatMap((r) => r.found.matches.map((match) => ({ cap: r.cap, match })));
  const ordered = [...found.filter((f) => isWholeName(f.match, t)), ...found.filter((f) => !isWholeName(f.match, t))];
  return pickFrom(module, t, ordered, done.some((r) => r.found.more));
}

/** owner_user: a CRM user of this tenant (crm-users.ts), only for callers who may pick users (L25). */
async function resolveOwner(input: RefInput, deps: RefDeps): Promise<RefResolution> {
  if (!deps.ctx.canPickUsers) return refused(USER_MODULE, 'no_permission');
  const tenantId = deps.identity.tenantId;
  if ('focus' in input) return notFound(USER_MODULE, null);
  if ('me' in input || 'ref' in input) {
    if ('ref' in input && input.module !== undefined && input.module !== USER_MODULE) return refused(USER_MODULE, 'not_a_user');
    const user = await crmUserRef(tenantId, 'me' in input ? deps.ctx.ownUser.id : input.ref);
    return user ? { state: 'resolved', ref: user } : refused(USER_MODULE, 'not_a_user');
  }
  const t = cleanText(input.text);
  if (!t) return notFound(USER_MODULE, null);
  const users = await lookupCrmUsers(tenantId, t, MAX_ENTITY_MATCHES);
  if (!users.length) return notFound(USER_MODULE, t);
  if (users.length === 1 && isWholeName(users[0], t)) {
    return { state: 'resolved', ref: { module: USER_MODULE, id: users[0].id, key: users[0].id, label: users[0].label } };
  }
  // The picker search returns at most MAX_ENTITY_MATCHES users: a full page may have more.
  return { state: 'ambiguous', module: USER_MODULE, text: t, candidates: users, more: users.length >= MAX_ENTITY_MATCHES };
}

/** One reference of a form field, under the referenced module's gates and scope (B9). */
export async function resolveFieldRef(field: WriteFormField, input: RefInput, deps: RefDeps): Promise<RefResolution> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return notFound(defaultModuleOf(field), null);
  if (field.kind === 'owner_user') return resolveOwner(input, deps);
  if (field.kind === 'related' && field.related) return resolveRelated(field, input, deps);
  if ((field.kind === 'ref' || field.kind === 'ref_many') && field.ref) return resolveRecord(field, input, deps);
  return refused(defaultModuleOf(field), 'unknown_module');
}

/** Every reference an intent or a fill names, parents before their children (customer before site,
 * team before staff) and the rest in parallel. A list field (staffIds) gives one resolution per record
 * named. A key missing from the answer was not resolved by `deadline` (epoch ms) or its read failed:
 * the form says "Pick it here." for it. A parent named here replaces the form's earlier one
 * (deps.resolved) for its children, even when it isn't resolved. */
export async function resolveFieldRefs(fields: readonly WriteFormField[], refs: Record<string, RefInput | RefInput[]>,
  deps: BatchDeps, deadline: number): Promise<Record<string, RefResolution | RefResolution[]>> {
  const out: Record<string, RefResolution | RefResolution[]> = {};
  const named = fields.filter((field) => isRefField(field) && has(refs, field.key));
  const remaining = deadline - Date.now();
  if (!named.length || remaining <= 0) return out;
  const resolved: Record<string, StoredRefValue | undefined> = { ...(deps.resolved ?? {}) };
  for (const field of named) resolved[field.key] = undefined;
  let open = true;

  const resolveOne = async (field: WriteFormField): Promise<void> => {
    const fieldDeps: RefDeps = { ...deps, resolved };
    const input = refs[field.key];
    try {
      if (field.kind === 'ref_many') {
        const inputs = (Array.isArray(input) ? input : [input]).slice(0, field.ref?.maxItems ?? MAX_MANY);
        const results = await Promise.all(inputs.map((one) => resolveFieldRef(field, one, fieldDeps)));
        if (!open) return;
        out[field.key] = results;
        const picked = results.flatMap((r) => (r.state === 'resolved' ? [r.ref] : []));
        resolved[field.key] = picked.length ? picked : undefined;
        return;
      }
      // One record per field: several named for it are left to the picker.
      const one = Array.isArray(input) ? (input.length === 1 ? input[0] : null) : input;
      if (!one) return;
      const result = await resolveFieldRef(field, one, fieldDeps);
      if (!open) return;
      out[field.key] = result;
      resolved[field.key] = result.state === 'resolved' ? result.ref : undefined;
    } catch (err) {
      // Left for the picker. Ids and keys only: the text typed is never logged.
      logger.warn('CRM assist: a form reference could not be resolved', { field: field.key, kind: field.kind, error: (err as Error)?.message });
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); });
  try {
    let pending = named;
    while (pending.length) {
      const ready = pending.filter((field) => !pending.some((p) => p.key === field.ref?.within?.field));
      if (!ready.length) break;
      pending = pending.filter((field) => !ready.includes(field));
      const finished = await Promise.race([Promise.all(ready.map(resolveOne)).then(() => true as const), late]);
      if (!finished) break;
    }
  } finally {
    open = false;
    if (timer) clearTimeout(timer);
  }
  return out;
}

/* ── Review and commit: every stored ref re-read ───────────────────────── */

async function recheckOne(
  field: WriteFormField, stored: StoredRef, refs: Readonly<Record<string, StoredRefValue | undefined>>, deps: Omit<RefDeps, 'resolved'>,
): Promise<{ ref: StoredRef } | { error: string }> {
  const module = field.ref ? field.ref.module : stored?.module;
  if (!stored || typeof stored !== 'object' || stored.module !== module || !isObjectIdText(stored.id)) return { error: REF_GONE };
  if (field.related && !field.related.modules.includes(module)) return { error: REF_GONE };
  const side = await deps.gate(module);
  if (!side.ok) return { error: REF_GONE };
  const keyPath = field.ref ? field.ref.targetField : relatedKeyPath(field.related!, side.cap);
  if (!keyPath) return { error: REF_GONE };
  const within = withinFor(field, refs);
  if (!within.ok) return { error: within.why === 'no_parent' ? PARENT_FIRST[module] : outsideParentText(field, stored, within.parent) };
  try {
    const match = (await resolveEntity(side.cap, { ref: stored.id }, side.ctx, { keyPath, extra: within.extra })).matches[0];
    // Still visible, still the same key: the label (and number) as the caller may see them now.
    if (match) return match.key && match.key === stored.key ? { ref: storedOf(module, match) } : { error: REF_GONE };
    if (within.extra.length && (await resolveEntity(side.cap, { ref: stored.id }, side.ctx, { keyPath })).matches.length) {
      return { error: outsideParentText(field, stored, within.parent) };
    }
    return { error: REF_GONE };
  } catch (err) {
    if (err instanceof ScopeFailClosedError) return { error: REF_GONE };
    throw err;
  }
}

/** At review and commit: each stored record ref (ref, ref_many, related) in `only` re-read by _id
 * under the current scope; it must still be visible, keep the same key and still sit within its
 * parent. Errors are B20 texts by field key (a list field: its first failing record). Refs that pass
 * get the labels the caller may see now; the others are returned as given. Owners are checked by the
 * validation stack itself (crmUserRef), and refs left out of `only` (an update's unchanged `source`
 * values) are neither read nor changed. */
export async function recheckRefs(fields: readonly WriteFormField[], refs: Record<string, StoredRefValue>,
  only: ReadonlySet<string> | 'all', deps: Omit<RefDeps, 'resolved'>): Promise<{ refs: Record<string, StoredRefValue>; errors: Record<string, string> }> {
  const out: Record<string, StoredRefValue> = { ...refs };
  const errors: Record<string, string> = {};
  const checked = fields.filter((field) => field.kind !== 'owner_user' && isRefField(field)
    && has(refs, field.key) && refs[field.key] && (only === 'all' || only.has(field.key)));
  await Promise.all(checked.map(async (field) => {
    const value = refs[field.key];
    const list = Array.isArray(value) ? value : [value];
    const results = await Promise.all(list.map((stored) => recheckOne(field, stored, refs, deps)));
    const failed = results.find((r): r is { error: string } => 'error' in r);
    if (failed) errors[field.key] = failed.error;
    const fresh = results.map((r, i) => ('ref' in r ? r.ref : list[i]));
    out[field.key] = Array.isArray(value) ? fresh : fresh[0];
  }));
  return { refs: out, errors };
}

/* ── Update forms: the record's stored keys as refs ─────────────────────── */

/** Stored keys of one module as refs, under its gates and scope (newest first, so the newest record
 * wins a number two records share). A key the caller can't see keeps id '' and shows as its key (a
 * record id never shows: the module's name instead, or the record's own stored label). */
async function refsByKey(
  module: string, keyPath: string | null, keys: readonly string[], deps: Omit<RefDeps, 'resolved'>, storedLabel?: unknown,
): Promise<StoredRef[]> {
  const hidden = (key: string): StoredRef => ({
    module, id: '', key, label: labelText(storedLabel) ?? labelText(key) ?? getModuleCap(module)?.labels.singular ?? 'Record',
  });
  if (!keyPath) return keys.map(hidden);
  const side = await deps.gate(module);
  if (!side.ok) return keys.map(hidden);
  const norm = (key: string) => (keyPath === '_id' ? key.toLowerCase() : key);
  const found = new Map<string, EntityMatch>();
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_ENTITY_MATCHES) chunks.push(keys.slice(i, i + MAX_ENTITY_MATCHES).map(norm));
  try {
    const reads = await Promise.all(chunks.map((chunk) => recentEntities(side.cap, side.ctx, {
      keyPath, limit: MAX_ENTITY_MATCHES, extra: [keyPath === '_id' ? idCondition('_id', chunk) : { [keyPath]: { $in: chunk } }],
    })));
    for (const match of reads.flat()) if (match.key && !found.has(match.key)) found.set(match.key, match);
  } catch (err) {
    if (!(err instanceof ScopeFailClosedError)) throw err;
  }
  return keys.map((key) => {
    const match = found.get(norm(key));
    return match ? storedOf(module, match) : hidden(key);
  });
}

async function storedRefOf(field: WriteFormField, record: Record<string, unknown>, deps: Omit<RefDeps, 'resolved'>): Promise<StoredRefValue | null> {
  if (field.kind === 'owner_user') {
    const key = keyText(record[field.key]);
    if (!key) return null;
    const user = deps.ctx.canPickUsers && isObjectIdText(key) ? await crmUserRef(deps.identity.tenantId, key) : null;
    if (user) return user;
    // Not a CRM user this caller may name: shown by the name the record keeps (lead.leadOwner), else as stored.
    const named = field.sets?.length ? labelText(record[field.sets[0].key]) : null;
    return { module: USER_MODULE, id: '', key, label: named ?? labelText(key) ?? 'User' };
  }
  if (field.kind === 'related' && field.related) {
    const module = typeof record.relatedModule === 'string' ? record.relatedModule.trim() : '';
    const key = keyText(record.relatedId);
    if (!module || !key) return null;
    if (!field.related.modules.includes(module)) return (await refsByKey(module, null, [key], deps, record.relatedLabel))[0];
    const keyPath = field.related.store === 'objectId' ? '_id' : getModuleCap(module)?.ids.business ?? null;
    return (await refsByKey(module, keyPath, [key], deps, record.relatedLabel))[0];
  }
  if (field.kind === 'ref' && field.ref) {
    const key = keyText(record[field.key]);
    return key ? (await refsByKey(field.ref.module, field.ref.targetField, [key], deps))[0] : null;
  }
  if (field.kind === 'ref_many' && field.ref) {
    const raw = record[field.key];
    const keys = [...new Set((Array.isArray(raw) ? raw : []).map(keyText).filter((k): k is string => !!k))];
    return keys.length ? refsByKey(field.ref.module, field.ref.targetField, keys, deps) : null;
  }
  return null;
}

/** Update forms: the record's stored references as StoredRefs, read under the current scope with the
 * labels the caller may see. A stored ref the caller can't see keeps id '' (it can't be picked or
 * checked) and shows as its stored key. */
export async function readStoredRefs(fields: readonly WriteFormField[], record: Record<string, unknown>,
  deps: Omit<RefDeps, 'resolved'>): Promise<Record<string, StoredRefValue>> {
  const out: Record<string, StoredRefValue> = {};
  await Promise.all(fields.filter(isRefField).map(async (field) => {
    const value = await storedRefOf(field, record, deps);
    if (value) out[field.key] = value;
  }));
  return out;
}

/** The value written into the record for this reference (its business key, its _id, or the user id). */
export function storedValueOf(field: WriteFormField, ref: StoredRef): string {
  switch (field.kind) {
    case 'owner_user': return ref.id;
    // relatedId: the record's _id (task, ticket, call) or, stored by number, its record number (activity).
    case 'related': return field.related?.store === 'business' ? ref.key : ref.id;
    case 'ref':
    case 'ref_many': return field.ref?.store === 'objectId' ? ref.id : ref.key;
    default: throw new Error(`"${field.key}" is not a reference field.`);
  }
}
