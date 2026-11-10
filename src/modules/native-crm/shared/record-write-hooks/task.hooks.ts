/** Task post-save steps — from tasks/task.controller.ts.
 * Same dependency path as the controller (timeline/timeline.service).
 *
 * Timeline entries on create (:36-37), update (:48-54) and delete (:65-66),
 * fire-and-forget as on the screen. The automations (:38, :55-56, :67) are
 * not part of this module. */

import { logTimeline } from '../../timeline/timeline.service';
import { RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** task.controller.ts create: the "created" timeline entry. */
export function logTaskCreated(tenantId: string, record: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'task', String((record as any)._id), 'created', `Task "${(record as any).title}" created`, userId,
    withOrigin({ taskStatus: (record as any).taskStatus, dueDate: (record as any).dueDate }, origin));
}

/** task.controller.ts update: "status_changed" when taskStatus really
 * changed against prev, otherwise "updated" (written on every update). */
export function logTaskUpdated(
  tenantId: string, record: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const statusChanged = body.taskStatus && prev && (prev as any).taskStatus !== body.taskStatus;
  return logTimeline(
    tenantId, 'task', String((record as any)._id), statusChanged ? 'status_changed' : 'updated',
    statusChanged ? `Status changed to ${body.taskStatus}` : `Task "${(record as any).title}" updated`,
    userId,
    withOrigin(statusChanged ? { previousStatus: (prev as any).taskStatus, newStatus: body.taskStatus } : undefined, origin),
  );
}

/** task.controller.ts remove: the "deleted" timeline entry. */
export function logTaskDeleted(tenantId: string, record: any, entityId: string, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'task', entityId, 'deleted', `Task "${(record as any).title}" deleted`, userId,
    withOrigin({ taskStatus: (record as any).taskStatus }, origin));
}

export const taskWriteHooks: RecordWriteHooks = {
  // prev is read only by the status_changed check.
  needsPrevOnUpdate: (payload) => !!payload.taskStatus,
  afterWriteFailureLevel: 'warn',
  async afterCreate(ctx, record) {
    logTaskCreated(ctx.tenantId, record, ctx.userId, ctx.origin).catch(ctx.swallow('task.timeline.created'));
  },
  async afterUpdate(ctx, record, prev, payload) {
    logTaskUpdated(ctx.tenantId, record, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('task.timeline.updated'));
  },
  async afterDelete(ctx, record, entityId) {
    logTaskDeleted(ctx.tenantId, record, entityId, ctx.userId, ctx.origin).catch(ctx.swallow('task.timeline.deleted'));
  },
};
