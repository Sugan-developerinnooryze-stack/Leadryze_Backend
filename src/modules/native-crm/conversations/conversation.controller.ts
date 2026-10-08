import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendPaginated } from '../../../utils/response';
import { ChatSession } from '../../bot/chat-session.model';
import { User } from '../../auth/auth.model';
import { Lead } from '../leads/lead.model';
import {
  claimConversation, appendStaffMessage, handBackToAi,
} from '../../bot/chat-handoff.service';
import {
  emitHandoffClaimed, emitHandoffMessage, emitHandoffClosed,
} from '../../../realtime/emit-helpers';
import { captureLeadFromExternalSource } from '../lead-capture/lead-capture.service';

/** Resolves "Firstname Lastname" for the calling staff member — JwtPayload
 * only carries email, not a display name, so every claim/reply/handback
 * that needs to push a human-readable name into the transcript (or
 * denormalize onto assignedToName) looks it up once here. */
async function getStaffName(userId: string): Promise<string> {
  const user = await User.findById(userId).select('firstName lastName').lean();
  return user ? `${user.firstName} ${user.lastName}`.trim() : 'A team member';
}

/** The shared claim queue list — Waiting/Mine/All tabs per the plan's own
 * "shared queue, not auto-assignment" decision. Deliberately NOT routed
 * through resolveEffectiveScope/DataScope: a handoff conversation belongs
 * to whichever staff member claims it from the shared queue, not to a
 * pre-assigned team/branch the way Leads/Tickets are scoped. */
export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, status } = req.query as { page?: string; limit?: string; status?: string };
    const pageNum  = parseInt(page || '1');
    const limitNum = Math.min(parseInt(limit || '20'), 100);

    const filter: Record<string, unknown> = { tenantId: req.tenantId };
    if (status === 'waiting') filter.handoffStatus = 'waiting';
    else if (status === 'claimed') filter.handoffStatus = 'claimed';
    // "Mine" means "I've touched this conversation" — every one currently
    // assigned to me (active) AND every one I claimed and later handed back
    // (history), since handBackToAi() deliberately never clears
    // assignedToUserId/assignedToName (see its own comment). NOT also
    // constrained to handoffStatus:'claimed' — that would make a
    // conversation vanish from a staffer's own view the instant they hand
    // it back, which is confusing (this exact gap was reported live).
    else if (status === 'mine') filter.assignedToUserId = req.user!.userId;
    else if (status === 'all') filter.handoffRequestedAt = { $exists: true };
    else filter.handoffStatus = { $in: ['waiting', 'claimed'] }; // default: the live inbox

    const [items, total] = await Promise.all([
      ChatSession.find(filter)
        .select('sessionId visitorName visitorEmail visitorPhone channel mode handoffStatus handoffRequestedAt claimedAt assignedToUserId assignedToName updatedAt messages')
        .sort({ updatedAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ChatSession.countDocuments(filter),
    ]);

    const rows = items.map((s) => {
      // The list preview should read like a real last-message snippet, not
      // an audit-trail line — 'system' messages (join/claim/hand-back
      // events) are skipped when picking what to show here, same posture as
      // the widget's own history rendering. Falls back to the most recent
      // message of any role only if a session somehow has nothing else yet.
      const messages = s.messages ?? [];
      const lastReal = [...messages].reverse().find((m) => m.role !== 'system');
      return {
        sessionId: s.sessionId,
        visitorName: s.visitorName,
        visitorEmail: s.visitorEmail,
        visitorPhone: s.visitorPhone,
        channel: s.channel,
        mode: s.mode,
        handoffStatus: s.handoffStatus,
        handoffRequestedAt: s.handoffRequestedAt,
        claimedAt: s.claimedAt,
        assignedToUserId: s.assignedToUserId,
        assignedToName: s.assignedToName,
        updatedAt: s.updatedAt,
        lastMessage: lastReal ?? (messages.length ? messages[messages.length - 1] : null),
      };
    });

    sendPaginated(res, rows, total, pageNum, limitNum);
  } catch { sendError(res, 'Failed to fetch conversations', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const session = await ChatSession.findOne({ tenantId: req.tenantId, sessionId: req.params.sessionId }).lean();
    if (!session) return void sendError(res, 'Conversation not found', 404);

    const lead = await Lead.findOne({ tenantId: req.tenantId, chatSessionId: session.sessionId })
      .select('leadId firstName lastName email phone status rating')
      .lean();

    sendSuccess(res, { ...session, lead: lead || null });
  } catch { sendError(res, 'Failed to fetch conversation', 500); }
}

export async function claim(req: AuthRequest, res: Response) {
  try {
    const userName = await getStaffName(req.user!.userId);
    const session = await claimConversation(req.tenantId!, req.params.sessionId, req.user!.userId, userName);
    if (!session) return void sendError(res, 'This conversation was already claimed by someone else', 409);

    const io = req.app.get('io');
    const payload = { sessionId: session.sessionId, assignedToUserId: session.assignedToUserId, assignedToName: session.assignedToName, claimedAt: session.claimedAt };
    emitHandoffClaimed(io, req.tenantId!, session.sessionId, payload);

    sendSuccess(res, session, 'Conversation claimed');
  } catch { sendError(res, 'Failed to claim conversation', 500); }
}

export async function reply(req: AuthRequest, res: Response) {
  try {
    const { content } = req.body as { content: string };
    const userName = await getStaffName(req.user!.userId);
    const session = await appendStaffMessage(req.tenantId!, req.params.sessionId, req.user!.userId, userName, content);
    if (!session) return void sendError(res, 'You do not own this conversation, or it is no longer active', 403);

    const message = session.messages[session.messages.length - 1];
    const io = req.app.get('io');
    emitHandoffMessage(io, req.tenantId!, session.sessionId, {
      role: 'staff', content: message.content, timestamp: message.timestamp, metadata: message.metadata,
    });

    sendSuccess(res, session, 'Reply sent');
  } catch { sendError(res, 'Failed to send reply', 500); }
}

export async function handback(req: AuthRequest, res: Response) {
  try {
    const session = await handBackToAi(req.tenantId!, req.params.sessionId, req.user!.userId);
    if (!session) return void sendError(res, 'You do not own this conversation, or it is no longer active', 403);

    const io = req.app.get('io');
    emitHandoffClosed(io, req.tenantId!, session.sessionId, { handedBackAt: session.handedBackAt });

    sendSuccess(res, session, 'Handed back to the AI assistant');
  } catch { sendError(res, 'Failed to hand back conversation', 500); }
}

/** Creates a Lead from the conversation's context panel, via the EXACT same
 * canonical path (captureLeadFromExternalSource) the AI's own widget-lead-
 * capture flow already uses — so a handoff-sourced Lead is indistinguishable
 * in the database from a chatbot-captured one. Body fields override the
 * session's own visitor* fields when supplied (a staff member correcting/
 * completing what the visitor typed), never the other way around. */
export async function createLead(req: AuthRequest, res: Response) {
  try {
    const session = await ChatSession.findOne({ tenantId: req.tenantId, sessionId: req.params.sessionId }).lean();
    if (!session) return void sendError(res, 'Conversation not found', 404);

    const body = req.body as { firstName?: string; lastName?: string; email?: string; phone?: string };
    const firstName = body.firstName || session.visitorName?.split(/\s+/)[0];
    if (!firstName) return void sendError(res, 'A name is required to create a Lead — ask the visitor or enter one manually', 400);
    const lastName = body.lastName ?? session.visitorName?.split(/\s+/).slice(1).join(' ');

    const { lead } = await captureLeadFromExternalSource(
      req.tenantId!, req.branchId ?? null, req.user!.userId, req.user!.email,
      {
        platform: 'chatbot',
        sourceUrl: `handoff:${session.sessionId}`,
        raw: { firstName, lastName, email: body.email || session.visitorEmail, phone: body.phone || session.visitorPhone },
        chatSessionId: session.sessionId,
      },
    );

    if (!lead) return void sendError(res, 'Could not create a Lead from this conversation', 500);
    sendSuccess(res, lead, 'Lead created');
  } catch { sendError(res, 'Failed to create lead', 500); }
}
