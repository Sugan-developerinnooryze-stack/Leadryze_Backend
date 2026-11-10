import { OPERATION_ID_RE } from '../contracts/api';
import type { AssistIdentity } from '../identity';
import { CrmAssistOperation, CrmAssistOperationDoc, OperationOp, OperationStatus } from './operation.model';

/* Which open form a typed answer ("fill", from the grammar or the planner)
 * belongs to (plan 5.3 step 4, spec B12.9). The planner never names an
 * operation: its typed values go to the session's own draft operation, whose
 * id the session state (else the browser's clientContext) carries as a hint.
 * The hint counts only when that operation is in the caller's tenant and
 * belongs to the same user, chat session and branch, is still a draft and
 * hasn't expired. A binding names the form's module and op. A refusal about
 * the caller's own operation in this session (another branch, no longer a
 * draft, expired) also names its status and module, so a typed answer while
 * its review card is open can be told to press Edit (L1); another user's or
 * session's operation is never described. Only the owner, status, module
 * and op fields are read (never the sealed values), and nothing is logged
 * here. */

export type FillBindingRefusal =
  | 'no_operation'    // no operation id in the session state or clientContext
  | 'not_found'       // not an operation id, or no such operation in this tenant
  | 'not_owner'       // another user's operation
  | 'other_session'   // the same user's, from another chat session
  | 'other_branch'    // started under another branch than the caller's current one
  | 'not_draft'       // no longer (or never) a draft: staged, applied, cancelled, ...
  | 'expired';

export type FillBinding =
  | { ok: true; operationId: string; module: string; op: OperationOp }
  | { ok: false; reason: FillBindingRefusal; status?: OperationStatus; module?: string };

type OwnerFields = Pick<CrmAssistOperationDoc, 'userId' | 'sessionId' | 'branchId' | 'status' | 'expiresAt' | 'module' | 'op'>;

/** A Date from any realm (instanceof is per realm: a structured clone's Date fails it), or its ISO text. */
function expiresAfter(expiresAt: unknown, now: Date): boolean {
  const isDate = Object.prototype.toString.call(expiresAt) === '[object Date]';
  const at = isDate || typeof expiresAt === 'string' ? new Date(expiresAt as Date | string) : null;
  return !!at && !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

/** The draft operation a fill from this caller and session may write to, or
 * why there is none. `operationId` is the session state's (else the
 * clientContext's) hint. */
export async function bindFill(
  identity: AssistIdentity, sessionId: string, operationId: string | undefined, now: Date = new Date(),
): Promise<FillBinding> {
  if (!operationId) return { ok: false, reason: 'no_operation' };
  if (!OPERATION_ID_RE.test(operationId)) return { ok: false, reason: 'not_found' };
  const doc = await CrmAssistOperation.findOne({ _id: operationId, tenantId: identity.tenantId })
    .select('userId sessionId branchId status expiresAt module op')
    .lean() as OwnerFields | null;
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.userId !== identity.userId) return { ok: false, reason: 'not_owner' };
  if (doc.sessionId !== sessionId) return { ok: false, reason: 'other_session' };
  // The caller's own operation in this chat session from here on.
  const own = { status: doc.status, module: doc.module };
  if ((doc.branchId ?? null) !== (identity.branchId ?? null)) return { ok: false, reason: 'other_branch', ...own };
  if (doc.status !== 'draft') return { ok: false, reason: 'not_draft', ...own };
  if (!expiresAfter(doc.expiresAt, now)) return { ok: false, reason: 'expired', ...own };
  return { ok: true, operationId, module: doc.module, op: doc.op };
}
