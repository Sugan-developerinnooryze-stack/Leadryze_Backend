import { Notification } from './notification.model';
import { IChatSession } from '../bot/chat-session.model';

/** Creates the persisted bell-notification counterpart to a handoff socket
 * event (emitHandoffRequested/emitHandoffMessage) — the socket event alone
 * only reaches whoever is connected right now; this is what the bell reads
 * back on next load / for a user who was offline when it fired.
 *
 * Targeting mirrors the handoff state machine's own single-owner rule: once
 * a conversation is claimed, only the claiming staffer should keep getting
 * pinged for it; while it's still waiting/unclaimed, every staffer who can
 * see the queue is a valid claimant, so the notification is tenant-wide. */
export async function createHandoffNotification(
  tenantId: string,
  session: Pick<IChatSession, 'sessionId' | 'assignedToUserId' | 'visitorName'>,
  event: 'requested' | 'message',
): Promise<void> {
  const who = session.visitorName || 'A visitor';
  const title = event === 'requested' ? 'New conversation waiting' : 'New message';
  const body = event === 'requested' ? `${who} requested a human agent` : `${who} sent a new message`;

  await Notification.create({
    tenantId,
    ...(session.assignedToUserId ? { userId: session.assignedToUserId } : {}),
    type: 'message',
    title,
    body,
    data: { sessionId: session.sessionId },
  });
}
