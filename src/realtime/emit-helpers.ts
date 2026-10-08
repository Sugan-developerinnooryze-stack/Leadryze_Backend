import type { Server as SocketIOServer } from 'socket.io';

/** Centralized Human Handoff event/room names — every emitter calls these
 * functions rather than hand-rolling `io.to(...).emit(...)` with a raw
 * string, so the emitting side and the frontend/widget listening side can
 * never drift apart via a typo. `io` is read per-call via `req.app.get('io')`
 * by callers (the same existing instance server.ts already stores there) —
 * these helpers never hold their own reference, so they work identically
 * whether called from an Express request or a background job. */

export const HANDOFF_EVENTS = {
  REQUESTED: 'handoff:requested',
  CLAIMED:   'handoff:claimed',
  MESSAGE:   'handoff:message',
  CLOSED:    'handoff:closed',
} as const;

export function conversationsRoom(tenantId: string): string {
  return `tenant:${tenantId}:conversations`;
}

export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

/** A visitor just requested a handoff — reaches every staff member watching
 * the shared queue (tenant:{id}:conversations only; never the broader,
 * ungated tenant:{id} room — see server.ts's own comment on why). */
export function emitHandoffRequested(io: SocketIOServer | undefined, tenantId: string, payload: Record<string, unknown>): void {
  io?.to(conversationsRoom(tenantId)).emit(HANDOFF_EVENTS.REQUESTED, payload);
}

/** A staff member claimed a waiting conversation — reaches the queue (so
 * every OTHER staff member's "Assign to me" disappears for this row) and
 * the session room (so the visitor's widget can show "You're chatting with
 * {name}"). */
export function emitHandoffClaimed(io: SocketIOServer | undefined, tenantId: string, sessionId: string, payload: Record<string, unknown>): void {
  io?.to(conversationsRoom(tenantId)).emit(HANDOFF_EVENTS.CLAIMED, payload);
  io?.to(sessionRoom(sessionId)).emit(HANDOFF_EVENTS.CLAIMED, payload);
}

/** A new message in either direction (visitor→staff or staff→visitor) —
 * reaches the queue (to bump the list preview/unread badge) and the
 * session room (to append it live in whichever thread — staff's or the
 * visitor's widget — is currently open). */
export function emitHandoffMessage(io: SocketIOServer | undefined, tenantId: string, sessionId: string, payload: Record<string, unknown>): void {
  io?.to(conversationsRoom(tenantId)).emit(HANDOFF_EVENTS.MESSAGE, { sessionId, ...payload });
  io?.to(sessionRoom(sessionId)).emit(HANDOFF_EVENTS.MESSAGE, payload);
}

/** Handed back to AI — reaches the queue (removes it from "Mine"/active)
 * and the session room (visitor's widget shows the hand-back message and
 * resumes polling... resumes normal AI chat). */
export function emitHandoffClosed(io: SocketIOServer | undefined, tenantId: string, sessionId: string, payload: Record<string, unknown>): void {
  io?.to(conversationsRoom(tenantId)).emit(HANDOFF_EVENTS.CLOSED, { sessionId, ...payload });
  io?.to(sessionRoom(sessionId)).emit(HANDOFF_EVENTS.CLOSED, payload);
}
