/** Invoice post-save steps — from invoices/invoice.controller.ts.
 * Same dependency paths as the controller (timeline.service,
 * record-lock.service, pipeline-config.service).
 *
 * Timeline entries on create (:54-55), update (:68-74, "status_changed"
 * whenever a status is sent, changed or not) and delete (:93-94), and the
 * auto-lock when an update sends the tenant's "paid" stage key (:75-79, PUT
 * semantics). The automations (:56, :80, :82, :95) are not part of this
 * module. */

import { logTimeline } from '../../timeline/timeline.service';
import { autoLockIfConfigured } from '../../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../../pipeline-config/pipeline-config.service';
import { RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** invoice.controller.ts create: the "created" timeline entry. */
export function logInvoiceCreated(tenantId: string, item: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'invoice', String(item._id), 'created', `Invoice ${(item as any).invoiceId} created`, userId,
    withOrigin({ status: (item as any).status, amount: (item as any).servicesAmountWithTax }, origin));
}

/** invoice.controller.ts update: "status_changed" whenever the body has a
 * status (even the current one), otherwise "updated". */
export function logInvoiceUpdated(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const action = body.status ? 'status_changed' : 'updated';
  const desc   = body.status ? `Status changed to ${body.status}` : `Invoice ${(item as any).invoiceId} updated`;
  return logTimeline(tenantId, 'invoice', String(item._id), action as any, desc, userId,
    withOrigin(body.status
      ? { previousStatus: (prev as any)?.status, newStatus: body.status, amount: (item as any).servicesAmountWithTax }
      : { amount: (item as any).servicesAmountWithTax }, origin),
  );
}

/** invoice.controller.ts update: when the body sends a status, the tenant's
 * "paid" key is looked up (awaited); if it matches, the record is auto-locked
 * (fire-and-forget; a failed lock goes to `onLockError`, which the screen
 * leaves as a no-op). */
export async function lockInvoiceIfPaid(
  tenantId: string, item: any, body: Record<string, any>, userId: string | undefined,
  onLockError: (err: unknown) => void = () => {},
): Promise<void> {
  if (!body.status) return;
  const paidKey = await getOutcomeStageKey(tenantId, 'invoice', 'paid', 'paid');
  if (body.status === paidKey) {
    autoLockIfConfigured(tenantId, 'invoices', String(item._id), paidKey, userId ?? 'system').catch(onLockError);
  }
}

/** invoice.controller.ts remove: the "deleted" timeline entry. */
export function logInvoiceDeleted(tenantId: string, item: any, entityId: string, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'invoice', entityId, 'deleted', 'Invoice deleted', userId,
    withOrigin({ status: (item as any).status, amount: (item as any).servicesAmountWithTax }, origin));
}

export const invoiceWriteHooks: RecordWriteHooks = {
  // prev is read only for previousStatus, which is written only with a status.
  needsPrevOnUpdate: (payload) => !!payload.status,
  afterWriteFailureLevel: 'warn',
  async afterCreate(ctx, item) {
    logInvoiceCreated(ctx.tenantId, item, ctx.userId, ctx.origin).catch(ctx.swallow('invoice.timeline.created'));
  },
  async afterUpdate(ctx, item, prev, payload) {
    logInvoiceUpdated(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('invoice.timeline.updated'));
    await lockInvoiceIfPaid(ctx.tenantId, item, payload, ctx.userId, ctx.swallow('invoice.autoLock'));
  },
  async afterDelete(ctx, item, entityId) {
    logInvoiceDeleted(ctx.tenantId, item, entityId, ctx.userId, ctx.origin).catch(ctx.swallow('invoice.timeline.deleted'));
  },
};
