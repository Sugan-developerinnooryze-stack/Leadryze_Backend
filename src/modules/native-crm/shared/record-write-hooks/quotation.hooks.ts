/** Quotation post-save steps — from quotations/quotation.controller.ts.
 * Same dependency paths as the controller (timeline.service,
 * record-lock.service, pipeline-config.service).
 *
 * Timeline entries on create (:55-56) and update (:69-75, "status_changed"
 * whenever a status is sent, changed or not), and the auto-lock when an
 * update sends the tenant's "approved" stage key (:76-80, PUT semantics; a
 * create is never locked). The automations (:57, :81, :83, :96) are not part
 * of this module. Neither is the delete's timeline entry and audit
 * (:94-108): quotations are never deleted from the assistant (D20), so the
 * module map has no delete for them. */

import { logTimeline } from '../../timeline/timeline.service';
import { autoLockIfConfigured } from '../../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../../pipeline-config/pipeline-config.service';
import { RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** quotation.controller.ts create: the "created" timeline entry. */
export function logQuotationCreated(tenantId: string, item: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'quotation', String(item._id), 'created', `Quotation ${(item as any).quotationId} created`, userId,
    withOrigin({ status: (item as any).status, amount: (item as any).servicesAmountWithTax }, origin));
}

/** quotation.controller.ts update: "status_changed" whenever the body has a
 * status (even the current one), otherwise "updated". */
export function logQuotationUpdated(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const action = body.status ? 'status_changed' : 'updated';
  const desc   = body.status ? `Status changed to ${body.status}` : `Quotation ${(item as any).quotationId} updated`;
  return logTimeline(tenantId, 'quotation', String(item._id), action as any, desc, userId,
    withOrigin(body.status
      ? { previousStatus: (prev as any)?.status, newStatus: body.status, amount: (item as any).servicesAmountWithTax }
      : { amount: (item as any).servicesAmountWithTax }, origin),
  );
}

/** quotation.controller.ts update: when the body sends a status, the
 * tenant's "approved" key is looked up (awaited); if it matches, the record
 * is auto-locked (fire-and-forget; a failed lock goes to `onLockError`,
 * which the screen leaves as a no-op). */
export async function lockQuotationIfApproved(
  tenantId: string, item: any, body: Record<string, any>, userId: string | undefined,
  onLockError: (err: unknown) => void = () => {},
): Promise<void> {
  if (!body.status) return;
  const approvedKey = await getOutcomeStageKey(tenantId, 'quotation', 'approved', 'approved');
  if (body.status === approvedKey) {
    autoLockIfConfigured(tenantId, 'quotations', String(item._id), approvedKey, userId ?? 'system').catch(onLockError);
  }
}

export const quotationWriteHooks: RecordWriteHooks = {
  // prev is read only for previousStatus, which is written only with a status.
  needsPrevOnUpdate: (payload) => !!payload.status,
  afterWriteFailureLevel: 'warn',
  async afterCreate(ctx, item) {
    logQuotationCreated(ctx.tenantId, item, ctx.userId, ctx.origin).catch(ctx.swallow('quotation.timeline.created'));
  },
  async afterUpdate(ctx, item, prev, payload) {
    logQuotationUpdated(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('quotation.timeline.updated'));
    await lockQuotationIfApproved(ctx.tenantId, item, payload, ctx.userId, ctx.swallow('quotation.autoLock'));
  },
};
