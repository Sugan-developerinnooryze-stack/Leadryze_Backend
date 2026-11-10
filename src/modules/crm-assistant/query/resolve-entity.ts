import type { ModuleCap } from '../registry/types';
import { ENTITY_NAME_FIELDS } from '../registry/relations';
import { isPiiField } from '../registry/query-caps';
import type { ExecContext } from './execute-list';
import { moduleDefFor, protectAndProject } from './execute-list';
import { fieldFor } from './compile';
import { businessNumberOf } from './validate';
import { idCondition, isObjectIdText, scopedCount, scopedFind, scopedFindById } from './scoped-match';
import { escapeRegex } from '../../../utils/escape-regex';

/* Finding the record someone names (plan 4.7, Increment 5): "work orders for
 * ABC Industries" first finds the customer, in the customer module, with the
 * caller's own scope for it (`ctx` comes from that module's gates): by name
 * (ENTITY_NAME_FIELDS, escaped and case-insensitive) or, when the text is one,
 * by the record's number; "invoices for this work order" re-reads the record
 * on screen by its _id under the same scope. Only records the caller may see
 * are ever found, counted or named. A match's label, number and detail come
 * from the module's read projection, exactly as a table shows them; the key a
 * relation refers to comes from the stored record and never leaves the
 * engine. Nothing here touches a model: every read is scoped-match.ts's. */

export interface EntityMatch {
  /** The record's _id (hex): what a plan's entity { ref } and record { ref } carry. */
  id: string;
  /** The value a relation refers to the record by (ResolveEntityOptions.keyPath): its number or its _id; '' when it has none. */
  key: string;
  /** Its name as a table shows it (the module's title fields), else its number. */
  label: string;
  /** Its record number, where a table shows one. */
  number?: string;
  /** Up to two more of the text fields its table shows, to tell matches apart ("Acme Corp · Chennai"). */
  detail?: string;
}

/** The forms a plan names a record in: typed text, a server-written _id, or the record on screen. */
export type EntityRequest = { text: string } | { ref: string } | { focus: true };

export interface ResolveEntityOptions {
  /** The path a relation refers to (RelationDef.parentKey); default the module's number field, else _id. */
  keyPath?: string;
  /** At most this many matches (default and at most MAX_ENTITY_MATCHES). */
  limit?: number;
  /** The record on screen (the record page the browser names, clientContext.focus, else the session's focus), for { focus: true }. */
  focus?: { module: string; id: string } | null;
  /** Text only: one read. When more match than fit, a record named exactly so
   * comes first only if it was among those read (a name looked for in other
   * modules, decision D12: one read each). */
  oneRead?: boolean;
  /** More conditions every read here ANDs in, each its own member next to the
   * name (or _id) condition and the closed scope, so they can only narrow: a
   * guided form's reference narrowed by its parent (Increment 6, a site within
   * the customer picked: { customerId: <the customer's _id> }). Server-built only. */
  extra?: Record<string, unknown>[];
}

/** A name matches at most this many records before the caller is asked to type more of it. */
export const MAX_ENTITY_MATCHES = 10;
/** labelsFor looks up at most this many keys at once (a breakdown shows at most 50 rows). */
const MAX_LABEL_KEYS = 200;
const MAX_NAME_TEXT = 100;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), record);
}

/** Text a person may read: never an id. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && !isObjectIdText(t) ? clip(t, max) : null;
}

/** A stored key as text: a string as stored, an ObjectId as its hex. */
function keyOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    const hex = String(value);
    return isObjectIdText(hex) ? hex.toLowerCase() : null;
  }
  return null;
}

function nameGroupsOf(module: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(ENTITY_NAME_FIELDS, module) ? ENTITY_NAME_FIELDS[module] : [];
}

/** Newest first (the module's creation date), _id as tie-breaker. */
function newestFirst(cap: ModuleCap): Record<string, 1 | -1> {
  const created = fieldFor(cap, cap.dates.created)?.path ?? cap.dates.created;
  return created === '_id' ? { _id: -1 } : { [created]: -1, _id: -1 };
}

function keyPathOf(cap: ModuleCap, keyPath: string | undefined): string {
  return keyPath ?? cap.ids.business ?? '_id';
}

/** The text as the name search reads it: one space between words, trimmed, at most MAX_NAME_TEXT characters. */
function nameText(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_TEXT) : '';
}

/** The text as one of the module's own record numbers, as the models store it; null when it is none. */
function ownNumber(cap: ModuleCap, t: string): string | null {
  const number = businessNumberOf(t);
  return number && number.module === cap.key && cap.ids.business ? number.number : null;
}

/** The records named `t` (escaped, case-insensitive): each group of
 * ENTITY_NAME_FIELDS on its own, a group of several paths matched against
 * their values joined with a space ("Ravi Kumar" across firstName and
 * lastName), plus an exact match on the module's number when `t` is one of
 * its numbers. `whole`: the whole name and nothing more (spaces around it
 * aside), else any name containing `t`. */
function nameCondition(cap: ModuleCap, t: string, whole: boolean): Record<string, unknown> | null {
  const or: Record<string, unknown>[] = [];
  for (const group of nameGroupsOf(cap.key)) {
    const paths = group.split(' ').filter(Boolean);
    if (paths.length === 1) {
      or.push({ [paths[0]]: whole ? new RegExp(`^\\s*${escapeRegex(t)}\\s*$`, 'i') : new RegExp(escapeRegex(t), 'i') });
    } else if (paths.length > 1) {
      const input = paths.flatMap((path, i) => [
        ...(i ? [' '] : []), { $convert: { input: `$${path}`, to: 'string', onError: '', onNull: '' } },
      ]);
      const regex = whole ? `^\\s*${escapeRegex(t)}\\s*$` : escapeRegex(t);
      or.push({ $expr: { $regexMatch: { input: { $concat: input }, regex, options: 'i' } } });
    }
  }
  const number = ownNumber(cap, t);
  if (number && cap.ids.business) or.push({ [cap.ids.business]: number });
  return or.length ? { $or: or } : null;
}

/** Whether a stored row is named `t` exactly, as nameCondition(cap, t, true) would match it. */
function namedExactly(cap: ModuleCap, t: string, row: Record<string, unknown>): boolean {
  const whole = new RegExp(`^\\s*${escapeRegex(t)}\\s*$`, 'i');
  const named = nameGroupsOf(cap.key).some((group) => {
    const paths = group.split(' ').filter(Boolean);
    const value = paths.length === 1
      ? getPath(row, paths[0])
      : paths.map((path) => { const v = getPath(row, path); return v === null || v === undefined ? '' : String(v); }).join(' ');
    return paths.length > 0 && typeof value === 'string' && whole.test(value);
  });
  const number = ownNumber(cap, t);
  return named || (!!number && !!cap.ids.business && getPath(row, cap.ids.business) === number);
}

/** The records whose name contains `text` (escaped, case-insensitive), or
 * whose number it is (nameCondition). Null when the module can't be searched
 * for it (no name fields and not one of its numbers) or the text is blank. */
export function entityNameCondition(cap: ModuleCap, text: string): Record<string, unknown> | null {
  const t = nameText(text);
  return t ? nameCondition(cap, t, false) : null;
}

/** The record's name: the first non-empty group of its title fields (as views/compose.ts titleOf reads them). */
function titleFor(cap: ModuleCap, shown: Record<string, unknown>): string | null {
  for (const group of cap.ids.title) {
    const parts = group.split(/[\s+]+/).filter(Boolean).map((path) => textOf(getPath(shown, path), 200)).filter((p): p is string => !!p);
    if (parts.length) return clip(parts.join(' '), 200);
  }
  return null;
}

/** Its record number, when its table may show one (not a hidden field). */
function numberFor(cap: ModuleCap, shown: Record<string, unknown>): string | null {
  const business = cap.ids.business;
  const field = business ? fieldFor(cap, business) : undefined;
  return field && field.read !== 'hidden' ? textOf(getPath(shown, field.path), 80) : null;
}

/** Up to two more text fields its table shows (never PII, never the title or number). */
function detailFor(cap: ModuleCap, shown: Record<string, unknown>): string | null {
  const used = new Set(cap.ids.title.flatMap((group) => group.split(/[\s+]+/)));
  if (cap.ids.business) used.add(cap.ids.business);
  const parts = cap.fields
    .filter((f) => f.read === 'list' && f.kind === 'text' && !f.virtual && !isPiiField(cap, f) && !used.has(f.path))
    .map((f) => textOf(getPath(shown, f.path), 80))
    .filter((p): p is string => !!p)
    .slice(0, 2);
  return parts.length ? clip(parts.join(' · '), 200) : null;
}

/** Stored rows the caller may see, described: their keys from the rows, their
 * names from the same rows after the read projection (applyPIIProtection,
 * the module's read fields, READ_FORBIDDEN_KEYS). `title` is the name alone
 * (null when the record has none to show). */
async function describe(
  cap: ModuleCap, ctx: ExecContext, rows: Record<string, unknown>[], keyPath: string,
): Promise<Array<{ match: EntityMatch; title: string | null }>> {
  if (!rows.length) return [];
  const projected = await protectAndProject(moduleDefFor(cap), rows, ctx);
  const shownById = new Map<string, Record<string, unknown>>();
  for (const item of projected) {
    const id = keyOf(item._id);
    if (id) shownById.set(id, item);
  }
  const out: Array<{ match: EntityMatch; title: string | null }> = [];
  for (const row of rows) {
    const id = keyOf(row._id);
    if (!id || !isObjectIdText(id)) continue;
    const shown = shownById.get(id) ?? {};
    const title = titleFor(cap, shown);
    const number = numberFor(cap, shown);
    const detail = detailFor(cap, shown);
    out.push({
      title,
      match: {
        id,
        key: keyPath === '_id' ? id : keyOf(getPath(row, keyPath)) ?? '',
        label: title ?? number ?? cap.labels.singular,
        ...(number ? { number } : {}),
        ...(detail ? { detail } : {}),
      },
    });
  }
  return out;
}

async function matchesOf(cap: ModuleCap, ctx: ExecContext, rows: Record<string, unknown>[], keyPath: string): Promise<EntityMatch[]> {
  return (await describe(cap, ctx, rows, keyPath)).map((d) => d.match);
}

async function byId(
  cap: ModuleCap, id: string, ctx: ExecContext, keyPath: string, extra: readonly Record<string, unknown>[],
): Promise<{ matches: EntityMatch[]; more: boolean }> {
  // With extra conditions the record must meet them in the same read (a site re-read within its customer).
  const row = !extra.length ? await scopedFindById(cap, ctx, id)
    : isObjectIdText(id) ? (await scopedFind(cap, ctx, [idCondition('_id', [id]), ...extra], { sort: { _id: 1 }, skip: 0, limit: 1 }))[0] ?? null
    : null;
  return { matches: row ? await matchesOf(cap, ctx, [row], keyPath) : [], more: false };
}

/** The records `entity` names in `parentCap`, read with `ctx` (that module's
 * gates and scope): typed text by name or number (those named exactly so
 * first, then the rest, newest first; at most `limit`, `more` when more
 * matched), a ref by its _id, the record on screen (opts.focus, only when it
 * belongs to this module) by its _id. Matches nothing when the text can't
 * name a record here or the record can't be seen. opts.extra narrows every
 * one of these reads. */
export async function resolveEntity(
  parentCap: ModuleCap, entity: EntityRequest, ctx: ExecContext, opts: ResolveEntityOptions = {},
): Promise<{ matches: EntityMatch[]; more: boolean }> {
  const keyPath = keyPathOf(parentCap, opts.keyPath);
  const extra = opts.extra ?? [];
  if ('focus' in entity) {
    const focus = opts.focus;
    if (!focus || focus.module !== parentCap.key || !isObjectIdText(focus.id)) return { matches: [], more: false };
    return byId(parentCap, focus.id, ctx, keyPath, extra);
  }
  if ('ref' in entity) return byId(parentCap, entity.ref, ctx, keyPath, extra);
  const t = nameText(entity.text);
  const condition = t ? nameCondition(parentCap, t, false) : null;
  if (!condition) return { matches: [], more: false };
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? MAX_ENTITY_MATCHES), 1), MAX_ENTITY_MATCHES);
  const sort = newestFirst(parentCap);
  const rows = await scopedFind(parentCap, ctx, [condition, ...extra], { sort, skip: 0, limit: limit + 1 });
  const more = rows.length > limit;
  // The records named exactly so come first. When more matched than fit they
  // are read on their own, so "Ravi" is offered even when ten newer "Ravi
  // Traders" match too; otherwise they are among the rows already read.
  const whole = more && !opts.oneRead ? nameCondition(parentCap, t, true) : null;
  const exact = whole
    ? await scopedFind(parentCap, ctx, [whole, ...extra], { sort, skip: 0, limit })
    : rows.filter((row) => namedExactly(parentCap, t, row));
  const first = new Set(exact.map((row) => keyOf(row._id)));
  const picked = [...exact, ...rows.filter((row) => !first.has(keyOf(row._id)))].slice(0, limit);
  return { matches: await matchesOf(parentCap, ctx, picked, keyPath), more };
}

/** The newest records of the module the caller may see (at most `limit`, 5 by
 * default): the choices when "this work order" names no record on screen.
 * `extra` narrows them as on resolveEntity (a form's picker before anything is
 * typed: the sites of the customer picked). */
export async function recentEntities(
  cap: ModuleCap, ctx: ExecContext, opts: { keyPath?: string; limit?: number; extra?: Record<string, unknown>[] } = {},
): Promise<EntityMatch[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), MAX_ENTITY_MATCHES);
  const rows = await scopedFind(cap, ctx, [...(opts.extra ?? [])], { sort: newestFirst(cap), skip: 0, limit });
  return matchesOf(cap, ctx, rows, keyPathOf(cap, opts.keyPath));
}

/** How many records the caller may see whose name (or number) matches
 * `text`; null when the module can't be searched for it. */
export async function countEntityMatches(cap: ModuleCap, text: string, ctx: ExecContext): Promise<number | null> {
  const condition = entityNameCondition(cap, text);
  if (!condition) return null;
  const n: unknown = await scopedCount(cap, ctx, [condition]);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Names for stored keys (a breakdown's customerIds, a relation's parent):
 * key -> the record's name, for the records `ctx` may see (it must come from
 * `parentCap`'s own gates). A key the caller can't see, or whose record has
 * no name to show, gets none: the stored number is shown instead. `keyPath`:
 * what the keys are (default the module's number field; '_id' for ids, as
 * lower-case hex). The newest record wins a number two records share. */
export async function labelsFor(
  parentCap: ModuleCap, keys: readonly string[], ctx: ExecContext, opts: { keyPath?: string } = {},
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const keyPath = opts.keyPath ?? parentCap.ids.business;
  if (!keyPath) return labels;
  const wanted = [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))].slice(0, MAX_LABEL_KEYS);
  if (!wanted.length) return labels;
  const condition = keyPath === '_id' ? idCondition('_id', wanted) : { [keyPath]: { $in: wanted } };
  const rows = await scopedFind(parentCap, ctx, [condition], { sort: newestFirst(parentCap), skip: 0, limit: MAX_LABEL_KEYS * 2 });
  for (const { match, title } of await describe(parentCap, ctx, rows, keyPath)) {
    if (title && match.key && !labels.has(match.key)) labels.set(match.key, title);
  }
  return labels;
}
