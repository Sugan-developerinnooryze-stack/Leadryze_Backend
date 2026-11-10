/** Ticket post-save steps — from tickets/ticket.controller.ts.
 * Same dependency path as the controller (logs/audit-log.model).
 *
 * The controller's only internal step is the delete audit (:57-69). Tickets
 * write no timeline. Its automations (:36, :46-47, :56) and the on-create
 * confirmation (ticket.service.ts) are not part of this module. */

import { logAuditEvent } from '../../../logs/audit-log.model';
import { AuditActor, RecordWriteHooks, WriteOrigin, withOrigin } from './types';

/** ticket.controller.ts remove: the ticket.deleted audit event. */
export function auditTicketDeleted(
  tenantId: string, actor: AuditActor, record: any, entityId: string, origin: WriteOrigin,
): Promise<void> {
  return logAuditEvent('ticket.deleted',
    actor,
    {
      tenantId,
      target: 'Ticket',
      targetId: (record as any).ticketId ?? entityId,
      detail: withOrigin({
        ticketId: (record as any).ticketId,
        subject: record.subject,
        before: { subject: record.subject, priority: record.priority, ticketStatus: record.ticketStatus },
      }, origin),
    },
  );
}

export const ticketWriteHooks: RecordWriteHooks = {
  needsPrevOnUpdate: () => false,
  afterWriteFailureLevel: 'warn',
  async afterDelete(ctx, record, entityId) {
    const actor = await ctx.getAuditActor();
    // logAuditEvent never rejects (it logs its own failure).
    await auditTicketDeleted(ctx.tenantId, actor, record, entityId, ctx.origin);
  },
};
