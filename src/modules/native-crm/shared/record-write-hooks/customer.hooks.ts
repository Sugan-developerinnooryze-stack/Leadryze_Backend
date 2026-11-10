/** Field Service Customer post-save steps — from customers/customer.controller.ts.
 * Same dependency paths as the controller (timeline.service, audit-log.model,
 * duplicate-check, customer.model).
 *
 * The create duplicate check (:50-53, which blocks), timeline entries on
 * create (:60-61), update (:75-81) and delete (:94), and the delete audit
 * (:95-107). Customers fire no automations. The allowDuplicate override
 * (:51) and the screen's 409 message stay on the screen. */

import { logTimeline } from '../../timeline/timeline.service';
import { logAuditEvent } from '../../../logs/audit-log.model';
import { findDuplicateContact } from '../duplicate-check';
import { NativeCustomer } from '../../customers/customer.model';
import { AuditActor, RecordWriteHooks, WriteOrigin, withOrigin, CUSTOMER_DUPLICATE_MESSAGE } from './types';

/** customer.controller.ts create: the exact email/phone match. */
export function findCustomerDuplicate(tenantId: string, data: Record<string, unknown>) {
  return findDuplicateContact(NativeCustomer, tenantId, data);
}

/** customer.controller.ts create: the "created" timeline entry. */
export function logCustomerCreated(tenantId: string, item: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'customer', String((item as any)._id), 'created', `Customer "${(item as any).name}" created`, userId,
    withOrigin({ status: (item as any).status }, origin));
}

/** customer.controller.ts update: "status_changed" when the status really
 * changed against prev, otherwise "updated" with no metadata. */
export function logCustomerUpdated(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const statusChanged = body.status && prev && (prev as any).status !== body.status;
  return logTimeline(
    tenantId, 'customer', String((item as any)._id), statusChanged ? 'status_changed' : 'updated',
    statusChanged ? `Status changed to ${body.status}` : `Customer "${(item as any).name}" updated`,
    userId,
    withOrigin(statusChanged ? { previousStatus: (prev as any).status, newStatus: body.status } : undefined, origin),
  );
}

/** customer.controller.ts remove: the "deleted" timeline entry. The screen
 * passes no metadata argument at all; the assistant passes { via }. */
export function logCustomerDeleted(tenantId: string, item: any, entityId: string, userId: string | undefined, origin: WriteOrigin) {
  const metadata = withOrigin(undefined, origin);
  return metadata === undefined
    ? logTimeline(tenantId, 'customer', entityId, 'deleted', `Customer "${(item as any).name}" deleted`, userId)
    : logTimeline(tenantId, 'customer', entityId, 'deleted', `Customer "${(item as any).name}" deleted`, userId, metadata);
}

/** customer.controller.ts remove: the customer.deleted audit event. */
export function auditCustomerDeleted(
  tenantId: string, actor: AuditActor, item: any, entityId: string, origin: WriteOrigin,
): Promise<void> {
  return logAuditEvent('customer.deleted',
    actor,
    {
      tenantId,
      target: 'Customer',
      targetId: (item as any).customerId ?? entityId,
      detail: withOrigin({
        customerId: (item as any).customerId,
        name: (item as any).name,
        before: { customerId: (item as any).customerId, name: (item as any).name },
      }, origin),
    },
  );
}

/** The assistant gateway's Customer steps. A duplicate is refused (409) with
 * a generic message that never names or points to the other customer. */
export const customerWriteHooks: RecordWriteHooks = {
  // prev is read only by the status_changed check.
  needsPrevOnUpdate: (payload) => !!payload.status,
  afterWriteFailureLevel: 'warn',
  async beforeCreate(ctx, data) {
    const duplicate = await findCustomerDuplicate(ctx.tenantId, data);
    return duplicate ? { block: { status: 409, message: CUSTOMER_DUPLICATE_MESSAGE } } : {};
  },
  async afterCreate(ctx, item) {
    logCustomerCreated(ctx.tenantId, item, ctx.userId, ctx.origin).catch(ctx.swallow('customer.timeline.created'));
  },
  async afterUpdate(ctx, item, prev, payload) {
    logCustomerUpdated(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('customer.timeline.updated'));
  },
  async afterDelete(ctx, item, entityId) {
    logCustomerDeleted(ctx.tenantId, item, entityId, ctx.userId, ctx.origin).catch(ctx.swallow('customer.timeline.deleted'));
    const actor = await ctx.getAuditActor();
    await auditCustomerDeleted(ctx.tenantId, actor, item, entityId, ctx.origin);
  },
};
