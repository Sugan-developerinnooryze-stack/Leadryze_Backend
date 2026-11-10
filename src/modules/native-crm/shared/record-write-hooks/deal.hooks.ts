/** Deal post-save steps — from deals/deal.controller.ts.
 * Same dependency paths as the controller (timeline.service, audit-log.model).
 *
 * Timeline entries on create (:36-37), update (:48-54) and delete (:72-73),
 * and the delete audit (:75-87). Since Increment 6 (D25, L24) the won-stage
 * auto-lock of PATCH /:id/stage (updateStage :106-109) also applies to an
 * update that MOVES the deal to the won stage: lockDealIfWon. NOT part of
 * this module: the automations (:38, :55-56, :74, :110) and the rest of
 * what PATCH /:id/stage does (updateStage :97-119). */

import { logTimeline } from '../../timeline/timeline.service';
import { logAuditEvent } from '../../../logs/audit-log.model';
import { autoLockIfConfigured } from '../../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../../pipeline-config/pipeline-config.service';
import { AuditActor, RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** deal.controller.ts create: the "created" timeline entry. */
export function logDealCreated(tenantId: string, record: any, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'deal', String(record._id), 'created', `Deal "${(record as any).title}" created`, userId,
    withOrigin({ stage: (record as any).stage, amount: (record as any).amount }, origin));
}

/** deal.controller.ts update: "stage_changed" when the stage really changed
 * against prev, otherwise "updated" with { amount } (written on every update). */
export function logDealUpdated(
  tenantId: string, record: any, prev: any, body: Record<string, any>, userId: string | undefined, origin: WriteOrigin,
) {
  const stageChanged = body.stage && prev && (prev as any).stage !== body.stage;
  return logTimeline(
    tenantId, 'deal', String(record._id), stageChanged ? 'stage_changed' : 'updated',
    stageChanged ? `Stage changed to ${body.stage}` : `Deal "${(record as any).title}" updated`,
    userId,
    withOrigin(stageChanged ? { previousStage: (prev as any).stage, newStage: body.stage } : { amount: (record as any).amount }, origin),
  );
}

/** deal.controller.ts updateStage (:106-109), applied to an update (D25,
 * L24): when the update MOVES the deal to the tenant's won stage, the won
 * key is looked up (awaited) and the record auto-locks if the tenant set
 * auto-lock up (fire-and-forget; a failed lock goes to onLockError). An
 * unchanged stage is not a move; with no prev (the pre-read failed) the
 * move is assumed, as PATCH does. No stage in the body: no lookup. Never
 * runAutomations (:110). */
export async function lockDealIfWon(
  tenantId: string, record: any, prev: any, body: Record<string, any>, userId: string | undefined,
  onLockError: (err: unknown) => void = () => {},
): Promise<void> {
  if (!body.stage) return;
  if (prev && (prev as any).stage === body.stage) return;
  const wonKey = await getOutcomeStageKey(tenantId, 'deal', 'won', 'closed_won');
  if (body.stage === wonKey) {
    autoLockIfConfigured(tenantId, 'deals', String(record._id), wonKey, userId ?? 'system').catch(onLockError);
  }
}

/** deal.controller.ts remove: the "deleted" timeline entry. */
export function logDealDeleted(tenantId: string, record: any, entityId: string, userId: string | undefined, origin: WriteOrigin) {
  return logTimeline(tenantId, 'deal', entityId, 'deleted', `Deal "${(record as any).title}" deleted`, userId,
    withOrigin({ stage: (record as any).stage, amount: (record as any).amount }, origin));
}

/** deal.controller.ts remove: the deal.deleted audit event. */
export function auditDealDeleted(
  tenantId: string, actor: AuditActor, record: any, entityId: string, origin: WriteOrigin,
): Promise<void> {
  return logAuditEvent('deal.deleted',
    actor,
    {
      tenantId,
      target: 'Deal',
      targetId: (record as any).dealId ?? entityId,
      detail: withOrigin({
        dealId: (record as any).dealId,
        title: (record as any).title,
        before: { title: (record as any).title, stage: (record as any).stage, amount: (record as any).amount },
      }, origin),
    },
  );
}

export const dealWriteHooks: RecordWriteHooks = {
  // prev is read only by the stage_changed check and the won-lock move check.
  needsPrevOnUpdate: (payload) => !!payload.stage,
  afterWriteFailureLevel: 'warn',
  async afterCreate(ctx, record) {
    logDealCreated(ctx.tenantId, record, ctx.userId, ctx.origin).catch(ctx.swallow('deal.timeline.created'));
  },
  async afterUpdate(ctx, record, prev, payload) {
    logDealUpdated(ctx.tenantId, record, prev, payload, ctx.userId, ctx.origin).catch(ctx.swallow('deal.timeline.updated'));
    await lockDealIfWon(ctx.tenantId, record, prev, payload, ctx.userId, ctx.swallow('deal.autoLock'));
  },
  async afterDelete(ctx, record, entityId) {
    logDealDeleted(ctx.tenantId, record, entityId, ctx.userId, ctx.origin).catch(ctx.swallow('deal.timeline.deleted'));
    const actor = await ctx.getAuditActor();
    await auditDealDeleted(ctx.tenantId, actor, record, entityId, ctx.origin);
  },
};
