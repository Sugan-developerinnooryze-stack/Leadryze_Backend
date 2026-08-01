import { AIAction } from './ai-action.model';

const MAX_MATCH_WINDOW_MS = 15000;

/**
 * Matches each assistant message in a ChatSession's messages[] array to its
 * nearest-in-time AIAction entry for the same session. AIAction has no
 * shared id with an individual message (they're written moments apart for
 * the same turn), so time-proximity is the correlation used — simpler and
 * more robust than positional matching, since fast-path-handled messages
 * (greetings, FAQ short-circuits) have a ChatSession entry but no AIAction
 * entry at all, which would otherwise misalign a positional match.
 *
 * Shared by both the Super Admin Conversation Inspector
 * (admin.routes.ts's /conversations/:sessionId) and the tenant-facing Chat
 * History panel (qna.routes.ts's /chat-history/:sessionId) — one
 * correlation implementation, not two copies.
 */
export async function attachAiActionTrace(
  sessionId: string,
  messages: Array<{ role: string; content: string; timestamp: Date | string; [key: string]: unknown }>
): Promise<Array<Record<string, unknown>>> {
  const actions = await AIAction.find({ sessionId }).sort({ createdAt: 1 }).lean();

  return messages.map((m) => {
    if (m.role !== 'assistant') return { ...m, trace: null };
    const msgTime = new Date(m.timestamp).getTime();
    let closest: any = null;
    let closestDiff = Infinity;
    for (const a of actions) {
      const diff = Math.abs(new Date((a as any).createdAt).getTime() - msgTime);
      if (diff < closestDiff) { closestDiff = diff; closest = a; }
    }
    const trace = closest && closestDiff < MAX_MATCH_WINDOW_MS
      ? { actionType: closest.actionType, summary: closest.summary, ...closest.metadata }
      : null;
    return { ...m, trace };
  });
}
