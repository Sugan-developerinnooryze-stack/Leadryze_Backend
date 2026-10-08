import { ChatSession, IChatSession } from './chat-session.model';

/** Single source of truth for every Human Handoff state transition — both
 * the public widget controller (visitor actions) and the staff-facing
 * conversations controller (staff actions) call into this, never a raw
 * findOneAndUpdate of their own, so the state machine only exists once. */

export interface VisitorMeta {
  visitorId?: string;
  visitorName?: string;
  visitorEmail?: string;
  visitorPhone?: string;
  channel?: string;
}

/** A visitor clicks "Connect with an expert." Upserts — a visitor's very
 * first action in a brand-new widget session can be this click, before any
 * ChatSession document exists yet. Pushes a 'system' audit message. */
export async function requestHandoff(
  tenantId: string,
  sessionId: string,
  visitorMeta: VisitorMeta,
): Promise<IChatSession> {
  const session = await ChatSession.findOneAndUpdate(
    { tenantId, sessionId },
    {
      $set: {
        mode: 'human',
        handoffStatus: 'waiting',
        handoffRequestedAt: new Date(),
        ...(visitorMeta.visitorId ? { visitorId: visitorMeta.visitorId } : {}),
        ...(visitorMeta.visitorName ? { visitorName: visitorMeta.visitorName } : {}),
        ...(visitorMeta.visitorEmail ? { visitorEmail: visitorMeta.visitorEmail } : {}),
        ...(visitorMeta.visitorPhone ? { visitorPhone: visitorMeta.visitorPhone } : {}),
      },
      $setOnInsert: { channel: visitorMeta.channel ?? 'web' },
      $push: { messages: { role: 'system', content: 'Visitor requested a human agent', timestamp: new Date() } },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return session!;
}

/** A visitor's text message while mode==='human' — never reaches the AI;
 * this is the human-mode counterpart to the AI proxy path. Filtered on
 * mode==='human' so a message can't land here if a handoff was never
 * actually granted (defense in depth alongside the controller's own gate). */
export async function appendVisitorMessage(
  tenantId: string,
  sessionId: string,
  content: string,
): Promise<IChatSession | null> {
  return ChatSession.findOneAndUpdate(
    { tenantId, sessionId, mode: 'human' },
    { $push: { messages: { role: 'user', content, timestamp: new Date() } } },
    { new: true },
  );
}

/** The atomic claim — MongoDB's own single-document findOneAndUpdate
 * atomicity is the entire race-condition fix. Two staff clicking "Assign to
 * me" within milliseconds of each other: exactly one findOneAndUpdate call
 * matches `handoffStatus:'waiting'` and transitions it; the other's filter
 * no longer matches (status is already 'claimed'), returns null, and the
 * caller treats that as "someone else got there first" (409). */
export async function claimConversation(
  tenantId: string,
  sessionId: string,
  userId: string,
  userName: string,
): Promise<IChatSession | null> {
  return ChatSession.findOneAndUpdate(
    { tenantId, sessionId, handoffStatus: 'waiting' },
    {
      $set: { handoffStatus: 'claimed', assignedToUserId: userId, assignedToName: userName, claimedAt: new Date() },
      $push: { messages: { role: 'system', content: `${userName} joined the conversation`, timestamp: new Date() } },
    },
    { new: true },
  );
}

/** A staff reply — single-owner thread: only the staffer who claimed this
 * conversation may push a message into it (no "transfer" action in V1; a
 * second staffer's attempt correctly matches nothing and returns null). */
export async function appendStaffMessage(
  tenantId: string,
  sessionId: string,
  userId: string,
  userName: string,
  content: string,
): Promise<IChatSession | null> {
  return ChatSession.findOneAndUpdate(
    { tenantId, sessionId, handoffStatus: 'claimed', assignedToUserId: userId },
    { $push: { messages: { role: 'staff', content, timestamp: new Date(), metadata: { staffUserId: userId, staffName: userName } } } },
    { new: true },
  );
}

/** Hands the conversation back to the AI — mode flips back to 'ai',
 * handoffStatus returns to 'none' (not a separate "closed" state; the
 * conversation structurally has no active handoff anymore, same as one
 * that's never requested one). Same single-owner filter as appendStaffMessage. */
export async function handBackToAi(
  tenantId: string,
  sessionId: string,
  userId: string,
): Promise<IChatSession | null> {
  return ChatSession.findOneAndUpdate(
    { tenantId, sessionId, handoffStatus: 'claimed', assignedToUserId: userId },
    {
      $set: { mode: 'ai', handoffStatus: 'none', handedBackAt: new Date(), handedBackByUserId: userId },
      $push: { messages: { role: 'system', content: 'Handed back to the AI assistant', timestamp: new Date() } },
    },
    { new: true },
  );
}
