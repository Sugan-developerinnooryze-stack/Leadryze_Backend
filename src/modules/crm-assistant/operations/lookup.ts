import { OPERATION_ID_RE } from '../contracts/api';
import type { EntityChoice, LookupResult, SectionState } from '../contracts/views';
import type { AssistIdentity } from '../identity';
import { getModuleCap } from '../registry';
import type { ModuleCap, WriteFormField } from '../registry/types';
import { gateRelated } from '../query/relations';
import type { RelatedRefusal } from '../query/relations';
import { EntityMatch, MAX_ENTITY_MATCHES, recentEntities, resolveEntity } from '../query/resolve-entity';
import { ScopeFailClosedError, idCondition, isObjectIdText } from '../query/scoped-match';
import { workflowModuleFor } from '../writes/write-caps';
import type { StoredRefValue, WorkflowCaller } from '../writes/workflow-types';
import type { CrmAssistOperationDoc } from './operation.model';
import { FORM_BRANCH_MESSAGE, FORM_CLOSED_MESSAGE, findOwned } from './operation.service';
import { isWorkflowSealed, unseal } from './sealed';
import type { WorkflowSealed } from './sealed';
import { canPickUsers, lookupCrmUsers } from './crm-users';
import { lookupCatalogLines } from './document-lines';

/* The record picker's search (Increment 6, spec B9; L9): bound to an open,
 * owned draft and one of its reference fields, so the server decides the
 * module, the scope and the parent (a site within the customer picked,
 * staff within the team picked). Never a free search API:
 *  - the operation is the caller's own draft in this chat session (any
 *    other answers "This form is no longer open."), in the same branch;
 *  - the field is a record, related or owner field of that form's own
 *    WriteCap, which names the module (a related field: one of its modules);
 *  - every read runs under the referenced module's own gates and scope
 *    (gateRelated), and a refused module answers with its state and no
 *    records, never with an unscoped read;
 *  - the parent comes only from the draft's sealed refs (resolved by the
 *    server), never from the request.
 * Reads only, at most 10 records. The query text is never logged.
 *
 * Increment 7 (spec B5.8): the field 'lines' of a document create picks a
 * catalog record for a new line (Add): only on a create whose WriteCap has
 * lines and that isn't made from another record (whose lines are fixed);
 * active catalog records of a kind the lines take, under that module's own
 * gates and scope (document-lines.ts lookupCatalogLines). */

type LookupReply = { http: 200; result: LookupResult } | { http: 400 | 404 | 409; message: string };

/** On focus, with nothing typed: the newest records the caller can see. */
const RECENT_LIMIT = 5;
/** The longest text searched (LookupRequestSchema caps q at 100). */
const MAX_QUERY = 100;
/** A child that waits for its parent: the screen's site list waits for a customer (B9). */
const PARENT_FIRST: Readonly<Record<string, string>> = Object.freeze({ site: 'Pick a customer first.' });
const USER_MODULE = 'user';

const closed = (): LookupReply => ({ http: 404, message: FORM_CLOSED_MESSAGE });
const invalid = (what: string): LookupReply => ({ http: 400, message: `Invalid lookup request: ${what}` });
const answer = (items: EntityChoice[], more: boolean, state?: SectionState): LookupReply => ({
  http: 200, result: { items, more, state: state ?? { status: items.length ? 'ok' : 'empty' } },
});

/** A refused module (its gate): its state, "You can't look up <plural> here." (B20 REF_HIDDEN), no records. */
function refused(module: string, reason: RelatedRefusal): LookupReply {
  const plural = module === USER_MODULE ? 'users' : (getModuleCap(module)?.labels.plural ?? 'records').toLowerCase();
  const status: SectionState['status'] = reason === 'no_permission' ? 'no_permission' : reason === 'unknown_module' ? 'unsupported' : 'disabled';
  return answer([], false, { status, message: `You can't look up ${plural} here.` });
}

/** The text as the name search reads it: trimmed, one space between words, at most MAX_QUERY characters. */
function cleanQuery(q: unknown): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '';
}

function isLookupField(field: WriteFormField): boolean {
  return ((field.kind === 'ref' || field.kind === 'ref_many') && !!field.ref) || (field.kind === 'related' && !!field.related)
    || field.kind === 'owner_user';
}

function choiceOf(cap: ModuleCap, match: EntityMatch): EntityChoice {
  return {
    module: cap.key, id: match.id, label: match.label, source: cap.group,
    ...(match.number ? { number: match.number } : {}), ...(match.detail ? { detail: match.detail } : {}),
  };
}

/** The draft's guided-form payload, or null when it can't be read. */
function workflowSealedOf(doc: CrmAssistOperationDoc): WorkflowSealed | null {
  try {
    const sealed = unseal(doc.sealed);
    return isWorkflowSealed(sealed) ? sealed : null;
  } catch {
    return null;
  }
}

/** The draft's sealed refs (the records the server resolved for it), or null when they can't be read. */
function sealedRefsOf(doc: CrmAssistOperationDoc): Record<string, StoredRefValue> | null {
  return workflowSealedOf(doc)?.refs ?? null;
}

/** The condition narrowing a child to the parent picked on the same form ({ [childPath]: the parent's _id }), or
 * why nothing can be offered yet: a site waits for its customer, and a parent the caller can't see (or several)
 * can't narrow anything. No parent picked for anything else: no narrowing (staff without a team). */
function narrowing(field: WriteFormField, fields: readonly WriteFormField[], refs: Record<string, StoredRefValue>):
  { ok: true; extra: Record<string, unknown>[] } | { ok: false; message: string } {
  const within = field.ref?.within;
  if (!within) return { ok: true, extra: [] };
  const parent = Object.prototype.hasOwnProperty.call(refs, within.field) ? refs[within.field] : undefined;
  const waits = Object.prototype.hasOwnProperty.call(PARENT_FIRST, field.ref!.module) ? PARENT_FIRST[field.ref!.module] : undefined;
  if (parent === undefined || parent === null) return waits ? { ok: false, message: waits } : { ok: true, extra: [] };
  if (Array.isArray(parent) || !isObjectIdText(parent.id)) {
    const label = fields.find((f) => f.key === within.field)?.label.toLowerCase() ?? 'record it depends on';
    return { ok: false, message: waits ?? `Pick the ${label} first.` };
  }
  return { ok: true, extra: [idCondition(within.childPath, [parent.id])] };
}

/** Owners are CRM users (L25), searched only for a caller who may list users (users.view). */
async function lookupOwners(identity: AssistIdentity, q: string): Promise<LookupReply> {
  if (!await canPickUsers(identity.tenantId, identity).catch(() => false)) return refused(USER_MODULE, 'no_permission');
  const limit = q ? MAX_ENTITY_MATCHES : RECENT_LIMIT;
  const users = await lookupCrmUsers(identity.tenantId, q, limit);
  // The users search reads at most `limit`: a full page of a search may have more.
  return answer(users.slice(0, limit), !!q && users.length >= limit);
}

export async function lookupForDraft(input: { operationId: string; field: string; q: string; module?: string }, caller: WorkflowCaller):
  Promise<LookupReply> {
  const { identity, tenant } = caller;
  const now = caller.now ?? new Date();

  // 1. The caller's own operation in this chat session; another user's or session's reads as closed.
  const doc = OPERATION_ID_RE.test(input.operationId) ? await findOwned(input.operationId, identity, caller.sessionId) : null;
  if (!doc) return closed();
  // 2. The company the form was opened in.
  if ((doc.branchId ?? null) !== (identity.branchId ?? null)) return { http: 409, message: FORM_BRANCH_MESSAGE };
  // 3. Still a guided form's draft, not expired.
  if (doc.status !== 'draft' || doc.origin !== 'workflow' || !(new Date(doc.expiresAt).getTime() > now.getTime())) return closed();

  // 4. A record, related or owner field of this form: the form, never the request, names the module.
  const wf = doc.op === 'delete' ? undefined : workflowModuleFor(doc.module);
  // A document create's Add (Increment 7): its catalog, unless its lines come from the record it is made from.
  if (input.field === 'lines') {
    const spec = doc.op === 'create' ? wf?.cap.lines : undefined;
    const sealed = spec ? workflowSealedOf(doc) : null;
    if (!spec || !sealed || sealed.source.from) return invalid('field is not a record field of this form');
    return lookupCatalogLines({
      spec, ...(input.module !== undefined ? { module: input.module } : {}), q: cleanQuery(input.q), gate: gateRelated({ identity, tenant, now }),
    });
  }
  const field = wf?.cap.fields.find((f) => f.key === input.field && (f.ops as readonly string[]).includes(doc.op));
  if (!wf || !field || !isLookupField(field)) return invalid('field is not a record field of this form');
  const q = cleanQuery(input.q);

  // Owners: the CRM users.
  if (field.kind === 'owner_user') {
    if (input.module !== undefined && input.module !== USER_MODULE) return invalid('module is not the one this field looks up');
    return lookupOwners(identity, q);
  }
  let module: string;
  if (field.kind === 'related') {
    if (!input.module) return invalid('module is required for this field');
    if (!field.related!.modules.includes(input.module)) return invalid('module is not one this field looks up');
    module = input.module;
  } else {
    module = field.ref!.module;
    if (input.module !== undefined && input.module !== module) return invalid('module is not the one this field looks up');
  }

  // The referenced module's own gates and scope; a refusal is its state, with no records.
  const side = await gateRelated({ identity, tenant, now })(module);
  if (!side.ok) return refused(module, side.reason);
  // The key a reference stores: a record without it can't be picked, so it isn't offered.
  const keyPath = field.kind === 'related'
    ? (field.related!.store === 'objectId' ? '_id' : side.cap.ids.business ?? null)
    : field.ref!.targetField;
  if (!keyPath) return refused(module, 'unknown_module');
  // The parent from the draft's own refs (a site within its customer, staff within their team).
  const refs = field.ref?.within ? sealedRefsOf(doc) : {};
  if (!refs) return closed();
  const within = narrowing(field, wf.cap.fields, refs);
  if (!within.ok) return answer([], false, { status: 'empty', message: within.message });

  // Nothing typed: the newest records; else the name search (at most 10, and whether more matched).
  try {
    const found = q
      ? await resolveEntity(side.cap, { text: q }, side.ctx, { keyPath, limit: MAX_ENTITY_MATCHES, extra: within.extra })
      : { matches: await recentEntities(side.cap, side.ctx, { keyPath, limit: RECENT_LIMIT, extra: within.extra }), more: false };
    const usable = found.matches.filter((m) => !!m.key);
    return answer(usable.slice(0, MAX_ENTITY_MATCHES).map((m) => choiceOf(side.cap, m)), found.more || usable.length > MAX_ENTITY_MATCHES);
  } catch (err) {
    // The scope couldn't be built for this module: nothing is read, as for a refused module.
    if (err instanceof ScopeFailClosedError) return refused(module, 'no_permission');
    throw err;
  }
}
