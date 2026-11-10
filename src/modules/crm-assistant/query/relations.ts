import type { Cond, QueryPlan } from '../contracts/plan';
import type { ModuleCap } from '../registry/types';
import type { DataScope } from '../../../types';
import { getModuleCap } from '../registry';
import {
  ENTITY_ELSEWHERE_MODULES, ENTITY_NAME_FIELDS, RelationDef, defaultParentFor, relationFor, relationsTo,
} from '../registry/relations';
import { queryCapsFor } from '../registry/query-caps';
import { CRM_WRITE_MODULE_MAP } from '../../internal/crm-write.module-map';
import { GatewayTenant, TENANT_INACTIVE_MESSAGE, gateModuleRead } from '../gates';
import type { AssistIdentity } from '../identity';
import type { ExecContext } from './execute-list';
import type { ImpliedCondition } from './compile';
import { PartialReason, PlanRejectedError, QueryExtras, QueryNotice, compileQueryConditions } from './execute-query';
import { idCondition, isObjectIdText, scopedCount, scopedDistinct } from './scoped-match';
import { businessNumberOf } from './validate';
import {
  EntityMatch, MAX_ENTITY_MATCHES, countEntityMatches, labelsFor, recentEntities, resolveEntity,
} from './resolve-entity';
import { escapeRegex } from '../../../utils/escape-regex';
import { logger } from '../../../utils/logger';

/* Relationship questions (plan 4.7, decision D19, Increment 5), in two steps,
 * each under its own module's gates and scope (registry/relations.ts names
 * the relations):
 *
 *   has / has_none  "customers with (no) invoices": the child side runs first,
 *                   under the child module's gates and scope and the
 *                   relation's own conditions, and gives the distinct keys
 *                   its records refer to (at most MAX_RELATION_KEYS); the
 *                   parent then gets "key in" (has) or "key not in" (has_none)
 *                   those keys as its own $and member. Past the cap, has
 *                   answers in part (relation_key_cap, the first keys) and
 *                   has_none is refused. A child scope narrower than
 *                   everything makes the answer partial (scope_limited:
 *                   "with no invoices visible to you"), so hidden invoices
 *                   are never revealed.
 *   for             "work orders for ABC Industries": the parent is found
 *                   first, in its own module under its own gates and scope
 *                   (query/resolve-entity.ts), by name or number, by a
 *                   server-written ref, or as the record on screen; the
 *                   child then gets "key = the parent's" as its own $and
 *                   member. None found, several, more than ten, or no
 *                   record on screen: an outcome that says so (a notice, or
 *                   choices that re-run the same plan with entity { ref }),
 *                   never an empty list. A name read as the target's default
 *                   parent that none has is looked for in its other parents
 *                   too (decision D12: choices for those). A number other
 *                   records the caller can see share is listed with a
 *                   warning: the children can't be told apart.
 *
 * Every module touched goes through RelatedGate (gateRelated: tenant active,
 * flag, view permission, then that module's own scope and branch); a related
 * module the caller can't use is an outcome that says so, never an empty
 * join. The keys never widen anything: they only become extra members next
 * to the target's closed scope object (QueryExtras). Names of other modules'
 * records are shown only where the caller may read that module. */

export type RelatedRefusal = 'disabled' | 'no_permission' | 'unknown_module' | 'tenant_inactive';
export type RelatedGateResult = { ok: true; cap: ModuleCap; ctx: ExecContext } | { ok: false; reason: RelatedRefusal };
/** The gates for another module a question touches: its registry entry and
 * executor Q, then gateModuleRead (tenant active, flag, view permission),
 * giving the caller's own scope and branch for it. */
export type RelatedGate = (module: string) => Promise<RelatedGateResult>;

/** At most this many distinct keys come from a relation's child side. */
export const MAX_RELATION_KEYS = 10_000;
/** "This work order" with none on screen: at most this many recent ones to choose from. */
export const MAX_RECENT_PARENTS = 5;

/** A choice of parent: the same plan, re-run with entity { ref: match.id }. */
export interface EntityChoice { match: EntityMatch; plan: QueryPlan }
/** Where else a name that matched nothing was found (a module the caller can read). */
export interface ElsewhereCount { module: string; label: string; count: number }
/** The child side of a has / has_none relation, for the answer's wording. */
export interface RelatedSide { cap: ModuleCap; scopeKind: DataScope['kind']; where?: Cond[]; implied: ImpliedCondition[] }

export type RelationOutcome =
  /** Run the target with `extras`; `plan` is the one to show and keep (a found parent as entity { ref }). */
  | {
    kind: 'ready'; relation: RelationDef | null; plan: QueryPlan; extras: QueryExtras; chip: string | null;
    related?: RelatedSide; parent?: { cap: ModuleCap; match: EntityMatch };
  }
  /** No parent the caller can see has that name (or that ref); `elsewhere`: other modules where the name is. */
  | { kind: 'entity_not_found'; relation: RelationDef; parent: ModuleCap; text: string | null; elsewhere: ElsewhereCount[]; notice: QueryNotice }
  /** Several parents match: up to MAX_ENTITY_MATCHES choices; `more` when more matched. Also
   * (decision D12) none of `parent` does, and the choices are records of the target's other parents. */
  | {
    kind: 'entity_ambiguous'; relation: RelationDef; parent: ModuleCap; text: string | null; choices: EntityChoice[]; more: boolean;
    question: string; moreHint?: string;
  }
  /** "This <parent>" with no such record on screen (or one the caller can no longer see): recent ones to choose from. */
  | { kind: 'no_focus'; relation: RelationDef; parent: ModuleCap; choices: EntityChoice[]; question: string }
  /** The other module can't be used by this caller. */
  | { kind: 'related_unavailable'; relation: RelationDef; module: string; reason: RelatedRefusal; notice: QueryNotice }
  /** has_none past MAX_RELATION_KEYS: refused. */
  | { kind: 'too_many_keys'; relation: RelationDef; related: ModuleCap; notice: QueryNotice };

/* ── Gates ─────────────────────────────────────────────────────────────── */

function servedModule(module: string): ModuleCap | null {
  const cap = getModuleCap(module);
  if (!cap || !Object.prototype.hasOwnProperty.call(CRM_WRITE_MODULE_MAP, module)) return null;
  const def = CRM_WRITE_MODULE_MAP[module];
  // The same agreement the capability view requires, and executor Q (relations read with it).
  const agrees = def.flagKey === cap.gate.flagKey && def.permissionPrefix === cap.gate.permPrefix && def.logModule === cap.gate.scopeKey;
  return agrees && queryCapsFor(module)?.q ? cap : null;
}

/** A RelatedGate for one request: each module's gates run once (the answer
 * is kept for the request) and give the caller's ExecContext for it. */
export function gateRelated(input: { identity: AssistIdentity; tenant: GatewayTenant; now?: Date }): RelatedGate {
  const seen = new Map<string, Promise<RelatedGateResult>>();
  return (module) => {
    let result = seen.get(module);
    if (!result) {
      result = gateOne(module, input);
      seen.set(module, result);
    }
    return result;
  };
}

async function gateOne(module: string, input: { identity: AssistIdentity; tenant: GatewayTenant; now?: Date }): Promise<RelatedGateResult> {
  const cap = servedModule(module);
  if (!cap) return { ok: false, reason: 'unknown_module' };
  const { identity, tenant } = input;
  const gate = await gateModuleRead(identity.tenantId, tenant, identity, {
    flagKey: cap.gate.flagKey, label: CRM_WRITE_MODULE_MAP[module].label, viewPermission: `${cap.gate.permPrefix}.view`, scopeKey: cap.gate.scopeKey,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  return {
    ok: true,
    cap,
    ctx: {
      tenantId: identity.tenantId,
      identity: { userId: identity.userId, role: identity.role, ...(identity.roleId ? { roleId: identity.roleId } : {}) },
      branchId: gate.branchId,
      scope: gate.scope,
      timezone: tenant.timezone,
      ...(input.now ? { now: input.now } : {}),
    },
  };
}

/** Names for another module's stored keys, under that module's gates: an
 * empty map when the caller can't read it (the stored numbers are shown). */
export async function relatedLabels(
  gate: RelatedGate, module: string, keys: readonly string[], opts: { keyPath?: string } = {},
): Promise<Map<string, string>> {
  const side = await gate(module);
  return side.ok ? labelsFor(side.cap, keys, side.ctx, opts) : new Map();
}

/* ── Conditions ────────────────────────────────────────────────────────── */

/** A parent's id and the key its children refer to, from its stored record. */
export function relationParentOf(def: RelationDef, row: Record<string, unknown>): { id: string; key: string } | null {
  const id = row._id && typeof row._id === 'object' ? String(row._id) : typeof row._id === 'string' ? row._id : '';
  if (!isObjectIdText(id)) return null;
  if (def.parentKey === '_id') return { id: id.toLowerCase(), key: id.toLowerCase() };
  const value = row[def.parentKey];
  return { id: id.toLowerCase(), key: typeof value === 'string' ? value : '' };
}

/** The child's member for one parent: its key on the child (a list key holds
 * it among others; an older receipt may hold the invoice's _id instead; an
 * older contract or work order its single staffId, so either path matches,
 * inside this one member; a key typed by hand matches in any case). A parent
 * without the number its children refer to by has none of them. */
export function childConditionFor(def: RelationDef, parent: { id: string; key: string }): Record<string, unknown> {
  if (def.format === 'objectId') {
    return def.childStores === 'objectId' ? idCondition(def.childKey, [parent.id]) : { [def.childKey]: parent.id.toLowerCase() };
  }
  const keys = [...(parent.key ? [parent.key] : []), ...(def.alsoIdString && isObjectIdText(parent.id) ? [parent.id.toLowerCase()] : [])];
  if (!keys.length) return { _id: { $in: [] } };
  const values = keys.map((key) => (def.caseInsensitive ? new RegExp(`^${escapeRegex(key)}$`, 'i') : key));
  const on = (path: string) => ({ [path]: values.length === 1 ? values[0] : { $in: values } });
  return def.alsoChildKey ? { $or: [on(def.childKey), on(def.alsoChildKey)] } : on(def.childKey);
}

/** The distinct keys the child's records refer to, under the child's scope
 * and conditions: at most MAX_RELATION_KEYS, `more` past it. A second child
 * path (alsoChildKey) is read on its own and merged, the cap counting the
 * merged keys; keys typed by hand come back upper-cased, as the parents'
 * numbers are stored. */
async function childKeys(
  child: ModuleCap, ctx: ExecContext, conditions: Record<string, unknown>[], def: RelationDef,
): Promise<{ values: string[]; more: boolean }> {
  const reads = await Promise.all([
    scopedDistinct(child, ctx, conditions, def.childKey, { limit: MAX_RELATION_KEYS, unwind: def.many === true }),
    ...(def.alsoChildKey ? [scopedDistinct(child, ctx, conditions, def.alsoChildKey, { limit: MAX_RELATION_KEYS })] : []),
  ]);
  if (reads.length === 1 && !def.caseInsensitive) return reads[0];
  const merged = [...new Set(reads.flatMap((r) => r.values).map((key) => (def.caseInsensitive ? key.toUpperCase() : key)))].sort();
  return { values: merged.slice(0, MAX_RELATION_KEYS), more: reads.some((r) => r.more) || merged.length > MAX_RELATION_KEYS };
}

/** The parent's member for the child side's keys: key in them (has) or not (has_none). */
function parentCondition(def: RelationDef, keys: readonly string[], kind: 'has' | 'has_none'): Record<string, unknown> {
  const op = kind === 'has' ? 'in' : 'nin';
  if (def.format === 'objectId') return idCondition(def.parentKey, keys, op);
  const byKey = { [def.parentKey]: { [kind === 'has' ? '$in' : '$nin']: [...keys] } };
  const ids = def.alsoIdString ? keys.filter(isObjectIdText) : [];
  if (!ids.length) return byKey;
  const byId = idCondition('_id', ids, op);
  return kind === 'has' ? { $or: [byKey, byId] } : { $and: [byKey, byId] };
}

/* ── Wording ───────────────────────────────────────────────────────────── */

function lower(text: string): string {
  return text.toLowerCase();
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** The name as typed, short and without double quotes (it sits inside them). */
function quoted(text: string): string {
  const t = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

function andList(parts: string[]): string {
  return parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function notice(code: string, text: string, tone: QueryNotice['tone'] = 'info'): QueryNotice {
  return { code, tone, text };
}

/** Why the other module can't be used, and what that means for the question. */
function refusalNotice(cap: ModuleCap, module: string, reason: RelatedRefusal, kind: 'has' | 'has_none' | 'for'): QueryNotice {
  if (reason === 'tenant_inactive') return notice('module_refused', TENANT_INACTIVE_MESSAGE, 'warning');
  const other = getModuleCap(module);
  const because = kind === 'for'
    ? `so I can't find the ${lower(other?.labels.singular ?? 'record')} you named`
    : `so I can't tell which ${lower(cap.labels.plural)} have ${lower(other?.labels.plural ?? 'them')}`;
  if (!other || reason === 'unknown_module') return notice('module_refused', `That kind of record isn't available here yet, ${because}.`, 'warning');
  return reason === 'no_permission'
    ? notice('module_refused', `You don't have access to ${other.labels.plural}, ${because}.`, 'warning')
    : notice('module_refused', `${other.labels.plural} are turned off for your company, ${because}.`, 'warning');
}

/** Decision D19: the child's own page, filtered by this customer, lists only records created after the customer was. */
function floorNotice(cap: ModuleCap): QueryNotice {
  return notice('list_floor', `The ${cap.labels.plural} page lists only ${lower(cap.labels.plural)} created after the customer was, so its count can be lower.`);
}

function chipForParent(parent: ModuleCap, match: EntityMatch): string {
  const number = match.number && match.number !== match.label ? ` (${match.number})` : '';
  const text = `${parent.labels.singular}: ${match.label}${number}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/* ── Outcomes ──────────────────────────────────────────────────────────── */

function choiceFor(plan: QueryPlan, def: RelationDef, match: EntityMatch): EntityChoice {
  const { page: _page, ...rest } = plan;
  return { match, plan: { ...rest, relation: { kind: 'for', name: def.parent, entity: { ref: match.id } } } };
}

/** Records may share a number (only receipt numbers are unique), and children
 * refer to the number alone, so the children of every record with it are
 * listed for the one picked: a warning says so. Counted under the parent's
 * own scope, so a record the caller can't see is never revealed. Null when
 * no other visible record has the number, or the count fails. */
async function sharedNumberNotice(
  cap: ModuleCap, def: RelationDef, parent: ModuleCap, ctx: ExecContext, match: EntityMatch,
): Promise<QueryNotice | null> {
  if (def.format !== 'business' || parent.ids.businessUnique || !match.key) return null;
  let n: unknown;
  try {
    n = await scopedCount(parent, ctx, [{ [def.parentKey]: match.key }]);
  } catch (err) {
    logger.warn('CRM assist: records sharing a number could not be counted', { module: parent.key, error: (err as Error)?.message });
    return null;
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 2) return null;
  const number = match.number ? `the number ${match.number}` : 'one number';
  return notice('shared_number', `${n} ${lower(parent.labels.plural)} you can see share ${number}, so their `
    + `${lower(cap.labels.plural)} can't be told apart and are listed together.`, 'warning');
}

async function readyFor(
  cap: ModuleCap, plan: QueryPlan, def: RelationDef, parent: ModuleCap, ctx: ExecContext, match: EntityMatch,
): Promise<RelationOutcome> {
  const shared = await sharedNumberNotice(cap, def, parent, ctx, match);
  return {
    kind: 'ready',
    relation: def,
    plan: { ...plan, relation: { kind: 'for', name: def.parent, entity: { ref: match.id } } },
    extras: {
      conditions: [childConditionFor(def, match)],
      notices: [...(shared ? [shared] : []), ...(def.listFloor ? [floorNotice(cap)] : [])],
    },
    chip: chipForParent(parent, match),
    parent: { cap: parent, match },
  };
}

/** Other modules (company, contact, customer, lead) where the caller can see
 * records with this name, each counted under its own gates. A module the
 * caller can't read, or whose count fails, is left out (never guessed). */
async function elsewhereCounts(text: string, except: string, gate: RelatedGate): Promise<ElsewhereCount[]> {
  const found = await Promise.all(ENTITY_ELSEWHERE_MODULES.filter((m) => m !== except).map(async (module): Promise<ElsewhereCount | null> => {
    try {
      const side = await gate(module);
      if (!side.ok) return null;
      const n = await countEntityMatches(side.cap, text, side.ctx);
      return n !== null && n > 0 ? { module, label: n === 1 ? side.cap.labels.singular : side.cap.labels.plural, count: n } : null;
    } catch (err) {
      logger.warn('CRM assist: a name count elsewhere failed', { module, error: (err as Error)?.message });
      return null;
    }
  }));
  return found.filter((c): c is ElsewhereCount => c !== null);
}

/** Decision D12: a name read as the target's default parent ("work orders for
 * Ravi Kumar": a customer) that no such record has is looked for in the
 * target's other parents named in words (ENTITY_NAME_FIELDS: a staff member,
 * a team, a quotation), each under its own gates and with one read. What they
 * find is offered as choices, the same plan for that parent, in the
 * registry's order, at most MAX_ENTITY_MATCHES (`more` past it). A module the
 * caller can't use, or whose read fails, is left out (never guessed). */
async function otherParentChoices(
  cap: ModuleCap, plan: QueryPlan, def: RelationDef, text: string, gate: RelatedGate,
): Promise<{ choices: EntityChoice[]; more: boolean }> {
  const others = relationsTo(cap.key).filter((r) => r.parent !== def.parent
    && Object.prototype.hasOwnProperty.call(ENTITY_NAME_FIELDS, r.parent) && ENTITY_NAME_FIELDS[r.parent].length > 0);
  const found = await Promise.all(others.map(async (other) => {
    try {
      const side = await gate(other.parent);
      if (!side.ok) return null;
      const { matches, more } = await resolveEntity(side.cap, { text }, side.ctx, {
        keyPath: other.parentKey, limit: MAX_ENTITY_MATCHES, oneRead: true,
      });
      // Which kind of record each one is, before what tells them apart ("Staff member · Technician").
      const what = side.cap.labels.singular;
      return { more, choices: matches.map((m) => choiceFor(plan, other, { ...m, detail: m.detail ? `${what} · ${m.detail}` : what })) };
    } catch (err) {
      logger.warn('CRM assist: a name search in another parent failed', { module: other.parent, error: (err as Error)?.message });
      return null;
    }
  }));
  const choices = found.flatMap((f) => f?.choices ?? []);
  return { choices: choices.slice(0, MAX_ENTITY_MATCHES), more: choices.length > MAX_ENTITY_MATCHES || found.some((f) => f?.more) };
}

async function prepareFor(
  cap: ModuleCap, plan: QueryPlan, rel: Extract<NonNullable<QueryPlan['relation']>, { kind: 'for' }>, def: RelationDef,
  gate: RelatedGate, focus: { module: string; id: string } | null | undefined,
): Promise<RelationOutcome> {
  const side = await gate(def.parent);
  if (!side.ok) return { kind: 'related_unavailable', relation: def, module: def.parent, reason: side.reason, notice: refusalNotice(cap, def.parent, side.reason, 'for') };
  const parent = side.cap;
  const keyPath = def.parentKey;
  const singular = lower(parent.labels.singular);
  const entity = rel.entity;

  if ('focus' in entity) {
    const found = await resolveEntity(parent, entity, side.ctx, { keyPath, focus: focus ?? null });
    if (found.matches.length) return readyFor(cap, plan, def, parent, side.ctx, found.matches[0]);
    const recent = await recentEntities(parent, side.ctx, { keyPath, limit: MAX_RECENT_PARENTS });
    return { kind: 'no_focus', relation: def, parent, choices: recent.map((m) => choiceFor(plan, def, m)), question: `Which ${singular} do you mean?` };
  }
  if ('ref' in entity) {
    const found = await resolveEntity(parent, entity, side.ctx, { keyPath });
    if (found.matches.length) return readyFor(cap, plan, def, parent, side.ctx, found.matches[0]);
    return {
      kind: 'entity_not_found', relation: def, parent, text: null, elsewhere: [],
      notice: notice('entity_not_found', `I couldn't find that ${singular}, or you can't see it.`),
    };
  }

  const found = await resolveEntity(parent, entity, side.ctx, { keyPath, limit: MAX_ENTITY_MATCHES });
  if (found.matches.length === 1 && !found.more) return readyFor(cap, plan, def, parent, side.ctx, found.matches[0]);
  if (found.matches.length) {
    return {
      kind: 'entity_ambiguous', relation: def, parent, text: entity.text, more: found.more,
      choices: found.matches.map((m) => choiceFor(plan, def, m)),
      question: `More than one ${singular} matches "${quoted(entity.text)}". Which one do you mean?`,
      ...(found.more ? { moreHint: 'More match; type more of the name.' } : {}),
    };
  }
  const missing = `I couldn't find ${withArticle(singular)} named "${quoted(entity.text)}" that you can see.`;
  // The target's default parent, named by a name (not a record number): the
  // name may be one of its other parents' (decision D12). A plan can't tell
  // whether the parent's word was typed ("for customer X"), so that reads the same.
  if (def.parent === defaultParentFor(cap.key) && !businessNumberOf(entity.text)) {
    const others = await otherParentChoices(cap, plan, def, entity.text, gate);
    if (others.choices.length) {
      return {
        kind: 'entity_ambiguous', relation: def, parent, text: entity.text, more: others.more, choices: others.choices,
        question: `${missing} ${others.choices.length === 1 ? 'Did you mean this one?' : 'Did you mean one of these?'}`,
        ...(others.more ? { moreHint: 'More match; type more of the name.' } : {}),
      };
    }
  }
  const elsewhere = await elsewhereCounts(entity.text, parent.key, gate);
  const where = elsewhere.map((e) => `${e.count} ${lower(e.label)}`);
  return {
    kind: 'entity_not_found', relation: def, parent, text: entity.text, elsewhere,
    notice: notice('entity_not_found', missing + (where.length ? ` That name matches ${andList(where)}.` : '')),
  };
}

async function prepareHas(
  cap: ModuleCap, plan: QueryPlan, rel: Extract<NonNullable<QueryPlan['relation']>, { kind: 'has' | 'has_none' }>, def: RelationDef,
  gate: RelatedGate,
): Promise<RelationOutcome> {
  const side = await gate(def.child);
  if (!side.ok) return { kind: 'related_unavailable', relation: def, module: def.child, reason: side.reason, notice: refusalNotice(cap, def.child, side.reason, rel.kind) };
  const child = side.cap;
  const where = rel.where?.length ? rel.where : undefined;
  let compiled: { conditions: Record<string, unknown>[]; implied: ImpliedCondition[] };
  try {
    compiled = await compileQueryConditions(child, { v: 1, op: 'list', target: { module: child.key }, ...(where ? { where } : {}) }, side.ctx);
  } catch (err) {
    // Its conditions are the relation's: their problems point there.
    if (err instanceof PlanRejectedError) {
      throw new PlanRejectedError(err.problems.map((p) => (p.path ? { ...p, path: `relation.${p.path}` } : p)));
    }
    throw err;
  }
  const keys = await childKeys(child, side.ctx, compiled.conditions, def);
  const parents = lower(cap.labels.plural);
  const children = lower(child.labels.plural);
  if (keys.more && rel.kind === 'has_none') {
    return {
      kind: 'too_many_keys', relation: def, related: child,
      notice: notice('relation_too_many', `More than ${MAX_RELATION_KEYS.toLocaleString('en-US')} ${parents} have ${children}, too many to tell `
        + `which have none. Try a narrower question, such as ${parents} with no ${children} this year.`, 'warning'),
    };
  }

  const limited = side.ctx.scope.kind !== 'all';
  const notices: QueryNotice[] = [];
  if (keys.more) {
    notices.push(notice('relation_key_cap', `More than ${MAX_RELATION_KEYS.toLocaleString('en-US')} ${parents} have ${children}, so this `
      + `answer includes ${MAX_RELATION_KEYS.toLocaleString('en-US')} of them.`, 'warning'));
  }
  const currency = compiled.implied.find((c) => c.reason === 'currency');
  if (currency && 'v' in currency.cond && typeof currency.cond.v === 'string') {
    notices.push(notice('other_currencies', `Only ${children} in ${currency.cond.v} were compared.`));
  }
  const partialReasons: PartialReason[] = [...(keys.more ? ['relation_key_cap' as const] : []), ...(limited ? ['scope_limited' as const] : [])];
  return {
    kind: 'ready',
    relation: def,
    plan,
    extras: { conditions: [parentCondition(def, keys.values, rel.kind)], notices, ...(partialReasons.length ? { partialReasons } : {}) },
    chip: `${rel.kind === 'has' ? 'With' : 'With no'} ${children}${limited ? ' visible to you' : ''}`,
    related: { cap: child, scopeKind: side.ctx.scope.kind, ...(where ? { where } : {}), implied: compiled.implied },
  };
}

/** What `plan`'s relation adds to the read of `cap` (the target), worked out
 * under the other module's gates (`gate`): a ready QueryExtras, or an outcome
 * that says why it can't run as asked. `focus`: the record on screen (the
 * record page the browser names, clientContext.focus, else the session's
 * focus), for entity { focus: true }. A plan
 * without a relation is ready with no extras. The plan has passed
 * validateQueryPlan; a relation the registry doesn't name throws
 * PlanRejectedError, and so do relation.where conditions the compiler
 * refuses (paths under "relation."). Reads that fail throw, as executor Q's
 * do (ScopeFailClosedError included). */
export async function prepareRelation(
  cap: ModuleCap, plan: QueryPlan, gate: RelatedGate, focus?: { module: string; id: string } | null,
): Promise<RelationOutcome> {
  const rel = plan.relation;
  if (!rel) return { kind: 'ready', relation: null, plan, extras: { conditions: [], notices: [] }, chip: null };
  const def = relationFor(cap.key, rel.kind, rel.name);
  if (!def) {
    throw new PlanRejectedError([{ code: 'unsupported_option', path: 'relation.name', message: `${cap.labels.plural} have no "${rel.name.slice(0, 60)}" relation.` }]);
  }
  return rel.kind === 'for' ? prepareFor(cap, plan, rel, def, gate, focus) : prepareHas(cap, plan, rel, def, gate);
}
