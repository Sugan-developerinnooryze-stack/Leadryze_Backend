/** Work order post-save steps — from workorders/workorder.controller.ts.
 * Same dependency paths as the controller (timeline.service, audit-log.model,
 * record-lock.service, pipeline-config.service).
 *
 * Timeline entries on create (:71-72), update (:85-90, "status_changed"
 * whenever a status is sent) and delete (:109-110), the auto-lock when an
 * update sends the tenant's "completed" stage key (:91-95, PUT semantics)
 * and the delete audit (:112-124). The automations (:73, :96, :98, :111)
 * and the upload timelines (uploadFiles) are not part of this module. */

import { logTimeline } from '../../timeline/timeline.service';
import { logAuditEvent } from '../../../logs/audit-log.model';
import { autoLockIfConfigured } from '../../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../../pipeline-config/pipeline-config.service';
import { AuditActor, RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** workorder.controller.ts create: the "created" timeline entry. */
export function logWorkorderCreated(tenantId: string, item: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'workorder', String(item._id), 'created', `Work order ${(item as any).workOrderId} created`, userId,
    withOrigin({ status: (item as any).status, scheduledDate: (item as any).scheduledDate }, origin));
}

/** workorder.controller.ts update: "status_changed" whenever the body has a
 * status (even the current one), otherwise "updated" with no metadata. */
export function logWorkorderUpdated(
  tenantId: string, item: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const action = body.status ? 'status_changed' : 'updated';
  const desc   = body.status
    ? `Status changed to ${body.status}`
    : `Work order ${(item as any).workOrderId} updated`;
  return logTimeline(tenantId, 'workorder', String(item._id), action as any, desc, userId,
    withOrigin(body.status ? { previousStatus: (prev as any)?.status, newStatus: body.status } : undefined, origin));
}

/** workorder.controller.ts update: when the body sends a status, the
 * tenant's "completed" key is looked up (awaited); if it matches, the record
 * is auto-locked (fire-and-forget; a failed lock goes to `onLockError`). */
export async function lockWorkorderIfCompleted(
  tenantId: string, item: any, body: Record<string, any>, userId: string | undefined,
  onLockError: (err: unknown) => void = () => {},
): Promise<void> {
  if (!body.status) return;
  const completedKey = await getOutcomeStageKey(tenantId, 'workorder', 'completed', 'completed');
  if (body.status === completedKey) {
    autoLockIfConfigured(tenantId, 'workorders', String(item._id), completedKey, userId ?? 'system').catch(onLockError);
  }
}

/** workorder.controller.ts remove: the "deleted" timeline entry. */
export function logWorkorderDeleted(tenantId: string, item: any, entityId: string, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'workorder', entityId, 'deleted', `Work order deleted`, userId,
    withOrigin({ status: (item as any).status }, origin));
}

/** workorder.controller.ts remove: the workorder.deleted audit event. */
export function auditWorkorderDeleted(
  tenantId: string, actor: AuditActor, item: any, entityId: string, origin: WriteOrigin,
): Promise<void> {
  return logAuditEvent('workorder.deleted',
    actor,
    {
      tenantId,
      target: 'WorkOrder',
      targetId: (item as any).workOrderId ?? entityId,
      detail: withOrigin({
        workOrderId: (item as any).workOrderId,
        title: (item as any).title ?? (item as any).description,
        before: { status: (item as any).status },
      }, origin),
    },
  );
}

export const workorderWriteHooks: RecordWriteHooks = {
  // prev is read only for previousStatus, which is written only with a status.
  needsPrevOnUpdate: (payload) => !!payload.status,
  afterWriteFailureLevel: 'warn',
  async afterCreate(ctx, item) {
    logWorkorderCreated(ctx.tenantId, item, ctx.userId, ctx.origin).catch(ctx.swallow('workorder.timeline.created'));
  },
  async afterUpdate(ctx, item, prev, payload) {
    logWorkorderUpdated(ctx.tenantId, item, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('workorder.timeline.updated'));
    await lockWorkorderIfCompleted(ctx.tenantId, item, payload, ctx.userId, ctx.swallow('workorder.autoLock'));
  },
  async afterDelete(ctx, item, entityId) {
    logWorkorderDeleted(ctx.tenantId, item, entityId, ctx.userId, ctx.origin).catch(ctx.swallow('workorder.timeline.deleted'));
    const actor = await ctx.getAuditActor();
    await auditWorkorderDeleted(ctx.tenantId, actor, item, entityId, ctx.origin);
  },
};
