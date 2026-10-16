import { Request, Response } from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccessToken } from 'livekit-server-sdk';
import { config } from '../../config';
import { sendSuccess, sendError } from '../../utils/response';
import { logger } from '../../utils/logger';
import { resolveTenantByWidgetKey, isOriginAllowed, resolveWidgetTheme } from './public-widget.service';
import { ITenant } from '../tenants/tenant.model';
import { ChatSession } from '../bot/chat-session.model';
import { requestHandoff, appendVisitorMessage } from '../bot/chat-handoff.service';
import { emitHandoffRequested, emitHandoffMessage } from '../../realtime/emit-helpers';
import { createHandoffNotification } from '../notifications/notification.service';
import { assignRoundRobin } from '../native-crm/staffs/round-robin.service';
import { captureLeadFromExternalSource, hasRecentLeadForEmail } from '../native-crm/lead-capture/lead-capture.service';
import { PHONE_FORMAT_REGEX } from '../native-crm/leads/lead.validation';
import { claimWidgetSession, resolveWidgetSessionClaim, releaseWidgetSessionClaim } from '../internal/widget-session-claim.service';

const aiHeaders = { 'x-api-key': config.ai.internalApiKey };
const AI_URL = config.app.aiServiceUrl;

/** Sets Access-Control-Allow-Origin on the ACTUAL response (not just the
 * preflight) — the browser enforces CORS on every response, not only
 * OPTIONS. Returns whether the origin was allowed; callers reject with 403
 * if not (never silently proceed without the header — the browser would
 * block the response anyway, but this makes the source of the rejection
 * explicit in a same-origin curl/test call too). */
function applyCorsHeader(req: Request, res: Response, tenant: ITenant): boolean {
  const origin = req.header('Origin');
  if (!isOriginAllowed(origin, tenant.widget?.allowedDomains)) return false;
  res.set('Access-Control-Allow-Origin', origin as string);
  res.set('Vary', 'Origin');
  return true;
}

/** CORS preflight for both /config and /chat. widgetKey travels as a query
 * param specifically so it's available here — an OPTIONS preflight never
 * carries a body, so the querystring is the only place a per-request field
 * can be read at this point. Resolves the tenant fresh, same as the real
 * handlers below (needed there anyway to identify the tenant), so this is
 * cheap duplicated work, not a shortcut. */
export async function preflight(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string | undefined;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (tenant) {
    const origin = req.header('Origin');
    if (isOriginAllowed(origin, tenant.widget?.allowedDomains)) {
      res.set('Access-Control-Allow-Origin', origin as string);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Vary', 'Origin');
    }
  }
  res.sendStatus(204);
}

export async function getConfig(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }

  // The browser never learns the real Mongo tenantId — every subsequent
  // call re-resolves tenant from widgetKey server-side.
  sendSuccess(res, {
    companyName:  tenant.branding?.companyName || tenant.name,
    agentName:    tenant.aiConfig?.agentName || 'Assistant',
    // Widget-specific logo wins if set; falls back to the tenant's general
    // branding logo, then to no logo at all (widget renders a letter avatar).
    logoUrl:      tenant.widget?.logoUrl || tenant.branding?.logoUrl,
    primaryColor: tenant.branding?.primaryColor || '#00B8D9',
    theme:        resolveWidgetTheme(tenant),
    greeting:     tenant.widget?.greeting || 'Hi! How can I help you today?',
    language:     tenant.aiConfig?.language || 'en',
    template:     tenant.widget?.template || 'modern',
    // Flat label array — matches leadryze-widget's own this.quickQuestions
    // shape exactly (`for (const label of this.quickQuestions)`), so an
    // empty/absent array correctly falls through to the widget's own
    // QUICK_SUGGESTIONS default rather than this endpoint needing to know
    // that fallback text itself.
    quickQuestions: (tenant.widget?.quickQuestions ?? []).filter((q) => q.enabled).map((q) => q.text),
    showBookingQuickReply: !!tenant.widget?.showBookingQuickReply,
    voiceEnabled: !!tenant.widget?.voice?.enabled,
    voiceAutoPlay: tenant.widget?.voice?.autoPlay !== false,
    continuousVoiceEnabled: !!tenant.widget?.voice?.continuousModeEnabled,
    allowTextDuringVoice: tenant.widget?.voice?.allowTextDuringVoice !== false,
    // Explicit `=== true` check, never a truthy-ish fallback — an absent or
    // malformed humanHandoff block must always resolve to "button hidden,"
    // matching ground rule #1 (default OFF for every tenant, old and new).
    humanHandoffEnabled: tenant.widget?.humanHandoff?.enabled === true,
    humanHandoffButtonText: tenant.widget?.humanHandoff?.buttonText || 'Connect with an expert',
    humanHandoffWaitingMessage: tenant.widget?.humanHandoff?.waitingMessage
      || "We're connecting you with a team member — someone will be with you shortly.",
    // "Connect with Your Local Branch" — a SEPARATE feature from Human
    // Handoff above (a deterministic lead-capture form, not a live-agent
    // escalation). Same explicit `=== true` gate: an absent/misconfigured
    // tenant always resolves to "button hidden," never shown by accident.
    connectBranchEnabled: tenant.widget?.connectBranch?.enabled === true,
    connectBranchButtonText: tenant.widget?.connectBranch?.buttonText || 'Connect with Your Local Branch',
    connectBranchFormTitle: tenant.widget?.connectBranch?.formTitle || 'Connect with a branch',
    connectBranchFormDescription: tenant.widget?.connectBranch?.formDescription
      || "Leave your details and we'll be in touch shortly.",
    connectBranchSubmitButtonText: tenant.widget?.connectBranch?.submitButtonText || 'Submit',
    connectBranchSuccessMessage: tenant.widget?.connectBranch?.successMessage
      || "Thanks! We've received your details and will be in touch shortly.",
    connectBranchFields: (tenant.widget?.connectBranch?.fields ?? [])
      .filter((f) => f.enabled)
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options })),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True only for "nothing answered at all" / upstream-server-error failures
 * — a cold Render instance fails FAST this way (connection refused, no
 * `response` object at all) rather than hanging until the 100s timeout, since
 * there's nothing listening yet to even accept the connection. Deliberately
 * excludes any real 4xx from the AI service itself (bad input, moderation
 * rejection, etc.) — retrying those would be pointless and could mask a
 * genuine client-side problem behind a slow, misleading multi-attempt delay. */
function isRetryableInfraFailure(err: unknown): boolean {
  const response = (err as { response?: { status?: number } })?.response;
  return !response || (response.status !== undefined && response.status >= 500);
}

/** Confirmed, repeated real-world pattern (this exact failure diagnosed live
 * multiple times, both text and voice go through the same AI service):
 * Render's free/hobby tier goes to sleep after ~15 minutes idle, and the
 * very next request fails fast with a connection-level error while Render
 * cold-boots the instance — a second or third attempt 15-20s later
 * typically succeeds once the boot finishes. A scheduled keep-alive ping
 * (scheduler.service.ts) now also fights this at the source, but neither
 * that nor this retry can offer a hard guarantee on shared/sleeping
 * infrastructure — only a paid always-on tier does. This is strictly a
 * second layer: absorb a cold start INSIDE the "thinking…" wait the widget
 * already shows, so a visitor only ever sees the graceful "temporarily
 * unavailable" message after every reasonable attempt has genuinely
 * failed, not on the very first one. Shared by postChat/postVoiceChat —
 * `requestFn` carries whatever differs (JSON body vs multipart form). */
async function postToAiWithRetry<T>(requestFn: () => Promise<T>, logLabel: string): Promise<T> {
  const delaysMs = [15000, 20000]; // total added worst-case wait: ~35s across 2 retries, beyond the first attempt
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastErr = err;
      if (attempt === delaysMs.length || !isRetryableInfraFailure(err)) throw err;
      logger.warn(`${logLabel} hit an infra-level failure — retrying (likely AI service cold start)`, {
        attempt: attempt + 1, error: (err as Error).message,
      });
      await sleep(delaysMs[attempt]);
    }
  }
  throw lastErr; // unreachable — satisfies TS control-flow analysis
}

export async function postChat(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }

  const { sessionId, visitorId, message, pageUrl } = req.body as {
    sessionId: string; visitorId?: string; message: string; pageUrl?: string;
  };

  // Human Handoff AI-pause gate — checked BEFORE the AI proxy call below,
  // not as an after-the-fact filter. `=== 'human'` (never `!== 'ai'`), so a
  // session with no handoff fields at all (every tenant that's never used
  // this feature) always, safely falls through to the unchanged AI path
  // beneath this block.
  try {
    const existing = await ChatSession.findOne({ tenantId: tenant._id, sessionId }).select('mode').lean();
    if (existing?.mode === 'human') {
      const updated = await appendVisitorMessage(String(tenant._id), sessionId, message);
      if (updated) {
        const io = req.app.get('io');
        emitHandoffMessage(io, String(tenant._id), sessionId, {
          role: 'user', content: message, timestamp: new Date(),
        });
        await createHandoffNotification(String(tenant._id), updated, 'message');
      }
      sendSuccess(res, { response: '', humanMode: true }, 'Message sent to the team');
      return;
    }
  } catch (err) {
    logger.error('Human handoff pause-gate check failed', { tenantId: String(tenant._id), sessionId, error: (err as Error).message });
    // Fall through to the normal AI path — fail safe, not fail open.
  }

  try {
    // The EXISTING, unmodified AI /api/chat endpoint, called with the
    // EXISTING private internal key — identical shape to ai.routes.ts's own
    // (staff-authenticated) proxy. The public browser never sees this key
    // or talks to the AI service directly (see the plan's own "why the
    // browser must never call the AI service directly" section).
    const response = await postToAiWithRetry(() => axios.post(
      `${AI_URL}/api/chat`,
      {
        tenantId: String(tenant._id),
        sessionId,
        message,
        companyName: tenant.branding?.companyName || tenant.name,
        agentName: tenant.aiConfig?.agentName,
        language: tenant.aiConfig?.language,
        customInstructions: tenant.aiConfig?.systemPrompt,
        visitorId,
        pageUrl,
      },
      // Raised from 70s: the tool-calling loop (up to 3 rounds, each possibly
      // needing a primary+fallback retry) legitimately needs more room than a
      // single plain completion did when 70s was chosen.
      { headers: aiHeaders, timeout: 100000 },
    ), 'Widget chat proxy');
    sendSuccess(res, response.data.data, 'AI response generated');
  } catch (err) {
    // Deliberately generic — this route is reachable from arbitrary public
    // internet traffic, so a raw upstream error (which could reveal
    // internal URLs/stack traces) is never forwarded to the caller, only
    // logged server-side for diagnostics.
    logger.error('Widget chat proxy to AI service failed', { tenantId: String(tenant._id), error: (err as Error).message });
    sendError(res, 'The assistant is temporarily unavailable — please try again shortly', 502);
  }
}

/** One combined voice turn — receives a recorded audio blob, forwards it (plus
 * the same tenant-resolved context fields postChat() already resolves) to
 * the AI service's own combined transcribe→respond→synthesize endpoint, and
 * returns its JSON response untouched. Mirrors postChat()'s tenant/CORS/
 * error-handling shape exactly; the only new pieces are the voice-enabled
 * gate and forwarding a multipart body instead of JSON. */
export async function postVoiceChat(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }
  if (!tenant.widget?.voice?.enabled) { sendError(res, 'Voice is not enabled for this widget', 403); return; }

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) { sendError(res, 'audio file is required', 400); return; }

  const { sessionId, visitorId, pageUrl, durationSeconds } = req.body as {
    sessionId: string; visitorId?: string; pageUrl?: string; durationSeconds?: string;
  };

  // Same AI-pause gate as postChat() — voice is channel-agnostic to the
  // "AI never responds again once handed off" guarantee. Rejected outright
  // (no partial/empty-response shape to invent for audio) — the widget UI
  // hides voice controls once it sees humanMode from a prior text turn, so
  // this is a defense-in-depth 403, not the primary UX signal.
  try {
    const existing = await ChatSession.findOne({ tenantId: tenant._id, sessionId }).select('mode').lean();
    if (existing?.mode === 'human') {
      sendError(res, 'Voice is paused while you are connected with a team member', 403);
      return;
    }
  } catch (err) {
    logger.error('Human handoff pause-gate check failed', { tenantId: String(tenant._id), sessionId, error: (err as Error).message });
  }

  try {
    const voice = tenant.widget.voice;
    const form = new FormData();
    form.append('audio', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'audio');
    form.append('tenantId', String(tenant._id));
    form.append('sessionId', sessionId);
    form.append('companyName', tenant.branding?.companyName || tenant.name);
    if (tenant.aiConfig?.agentName) form.append('agentName', tenant.aiConfig.agentName);
    if (tenant.aiConfig?.language) form.append('language', tenant.aiConfig.language);
    if (visitorId) form.append('visitorId', visitorId);
    if (pageUrl) form.append('pageUrl', pageUrl);
    if (voice.sttProvider) form.append('sttProvider', voice.sttProvider);
    if (voice.ttsProvider) form.append('ttsProvider', voice.ttsProvider);
    if (voice.sttLanguage) form.append('sttLanguage', voice.sttLanguage);
    if (voice.voiceName) form.append('voiceName', voice.voiceName);
    if (durationSeconds) form.append('durationSeconds', durationSeconds);

    const response = await postToAiWithRetry(
      () => axios.post(`${AI_URL}/api/voice/chat`, form, { headers: aiHeaders, timeout: 100000 }),
      'Widget voice-chat proxy',
    );
    sendSuccess(res, response.data.data, 'Voice response generated');
  } catch (err) {
    logger.error('Widget voice-chat proxy to AI service failed', { tenantId: String(tenant._id), error: (err as Error).message });
    sendError(res, 'The assistant is temporarily unavailable — please try again shortly', 502);
  }
}

/** Full conversation history (text + push-to-talk + continuous voice, all
 * interleaved in the same ChatSession.messages array they already share) —
 * lets the widget rehydrate on a reload instead of always starting blank.
 * Ownership is checked on THREE factors, not just widgetKey+sessionId:
 * tenantId (implicit — resolved server-side from widgetKey, never trusted
 * from the client) + sessionId + visitorId. A request with the right
 * sessionId but the wrong visitorId matches nothing and returns an empty
 * history, not another visitor's transcript.
 *
 * Paginated (`limit`, hard-capped at 200 regardless of what's requested;
 * `before` an ISO-timestamp cursor) and field-allowlisted on the response —
 * only {role, content, timestamp, channel} per message. Deliberately
 * EXCLUDES `metadata` (provider/model/escalation — internal detail, not
 * conversation content), any Mongo _id, and visitorName/visitorEmail/
 * visitorPhone (this endpoint returns transcript text only, never captured
 * lead PII, even though it lives in the same document). */
export async function getHistory(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }

  const sessionId = req.query.sessionId as string;
  const visitorId = req.query.visitorId as string;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before as string | undefined;

  try {
    const session = await ChatSession.findOne({
      tenantId: tenant._id,
      sessionId,
      visitorId,
    }).select('messages channel').lean();

    if (!session) { sendSuccess(res, { messages: [], hasMore: false }); return; }

    let messages = session.messages || [];
    if (before) {
      const cutoff = new Date(before).getTime();
      messages = messages.filter((m) => new Date(m.timestamp).getTime() < cutoff);
    }
    // Most recent `limit` messages older than `before` (or overall, if
    // `before` is omitted) — sliced off the end, then re-sorted ascending
    // for the widget to render in natural chronological order.
    const hasMore = messages.length > limit;
    const page = messages.slice(Math.max(0, messages.length - limit));

    sendSuccess(res, {
      messages: page.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        channel: session.channel,
      })),
      hasMore,
    });
  } catch (err) {
    logger.error('Widget history fetch failed', { tenantId: String(tenant._id), error: (err as Error).message });
    sendError(res, 'Could not load conversation history', 502);
  }
}

/** Mints a scoped LiveKit access token for the continuous, hands-free voice
 * mode — a completely separate capability from postVoiceChat() above
 * (push-to-talk). Gated on its own `continuousModeEnabled` flag so a tenant
 * can run either, both, or neither independently. The room name is tagged
 * with tenantId+sessionId (not just a random string) so the ai/ voice-agent
 * worker — which never receives an HTTP request, only a LiveKit job dispatch
 * carrying the room name — can recover which tenant/session this
 * conversation belongs to and read the SAME Redis conversation state a text
 * or push-to-talk turn already uses. */
export async function getVoiceToken(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }
  if (!tenant.widget?.voice?.continuousModeEnabled) {
    sendError(res, 'Continuous voice mode is not enabled for this widget', 403);
    return;
  }
  if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
    logger.error('LiveKit is not configured — missing LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET');
    sendError(res, 'Voice conversation is temporarily unavailable', 503);
    return;
  }

  const { sessionId, visitorId } = req.body as { sessionId: string; visitorId?: string };
  if (!sessionId) { sendError(res, 'sessionId is required', 400); return; }

  // Same AI-pause gate — rejects minting a NEW continuous-voice room while
  // handed off. An already-in-progress LiveKit call can't be interrupted
  // mid-call by this check (accepted V1 edge case, out of scope per plan).
  try {
    const existing = await ChatSession.findOne({ tenantId: tenant._id, sessionId }).select('mode').lean();
    if (existing?.mode === 'human') {
      sendError(res, 'Voice is paused while you are connected with a team member', 403);
      return;
    }
  } catch (err) {
    logger.error('Human handoff pause-gate check failed', { tenantId: String(tenant._id), sessionId, error: (err as Error).message });
  }

  try {
    const room = `voice-${String(tenant._id)}-${sessionId}`;
    const identity = `visitor-${visitorId || randomUUID()}`;

    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      ttl: '15m',
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    const token = await at.toJwt();

    sendSuccess(res, { token, url: config.livekit.url, room, identity });
  } catch (err) {
    logger.error('LiveKit token minting failed', { tenantId: String(tenant._id), error: (err as Error).message });
    sendError(res, 'Voice conversation is temporarily unavailable', 502);
  }
}

/** A visitor clicks "Connect with an expert." Explicit `=== true` gate (same
 * reasoning as getConfig()'s humanHandoffEnabled) — a tenant that's never
 * configured this, or has it explicitly off, gets a clean 403, never a
 * half-started handoff. On success: flips the session to human/waiting via
 * the shared state-machine service, notifies the staff queue over the
 * existing Socket.IO server, and mints a narrowly-scoped widget socket
 * token (scope:'widget' — deliberately no userId/role, see server.ts's own
 * io.use comment) so the widget can open a real, bidirectional connection
 * for just this one conversation. */
export async function postHandoffRequest(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }
  if (tenant.widget?.humanHandoff?.enabled !== true) {
    sendError(res, 'Connecting with an expert is not available for this widget', 403);
    return;
  }

  const { sessionId, visitorId, visitorName, visitorEmail, visitorPhone } = req.body as {
    sessionId: string; visitorId?: string; visitorName?: string; visitorEmail?: string; visitorPhone?: string;
  };

  try {
    const tenantId = String(tenant._id);
    const session = await requestHandoff(tenantId, sessionId, {
      visitorId, visitorName, visitorEmail, visitorPhone, channel: 'web',
    });

    const io = req.app.get('io');
    emitHandoffRequested(io, tenantId, {
      sessionId,
      visitorName: session.visitorName,
      visitorEmail: session.visitorEmail,
      pageUrl: (req.body as { pageUrl?: string }).pageUrl,
      requestedAt: session.handoffRequestedAt,
    });
    await createHandoffNotification(tenantId, session, 'requested');

    // Short-lived, single-conversation widget socket token — see server.ts's
    // io.use for the matching verification branch. No `userId`/`role` in
    // this payload at all (structurally distinct from a staff login token).
    const widgetToken = jwt.sign(
      { scope: 'widget', tenantId, sessionId },
      config.jwt.secret,
      { expiresIn: '2h' },
    );

    sendSuccess(res, {
      status: session.handoffStatus,
      widgetToken,
      waitingMessage: tenant.widget?.humanHandoff?.waitingMessage
        || "We're connecting you with a team member — someone will be with you shortly.",
    }, 'Handoff requested');
  } catch (err) {
    logger.error('Human handoff request failed', { tenantId: String(tenant._id), sessionId, error: (err as Error).message });
    sendError(res, 'Could not connect you with a team member right now — please try again shortly', 502);
  }
}

/** One-time catch-up fetch for the handoff thread specifically — called once
 * on widget reopen/reconnect, NOT polled on an interval (the whole point of
 * the real Socket.IO upgrade is that no polling is needed for live updates).
 * Reuses getHistory()'s exact tenantId+sessionId+visitorId ownership
 * pattern — same three-factor check, same field allow-list. */
export async function getHandoffHistory(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }

  const sessionId = req.query.sessionId as string;
  const visitorId = req.query.visitorId as string;

  try {
    const session = await ChatSession.findOne({ tenantId: tenant._id, sessionId, visitorId })
      .select('messages mode handoffStatus assignedToName')
      .lean();

    if (!session) { sendSuccess(res, { messages: [], mode: 'ai', handoffStatus: 'none' }); return; }

    sendSuccess(res, {
      messages: (session.messages || []).map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      mode: session.mode || 'ai',
      handoffStatus: session.handoffStatus || 'none',
      assignedToName: session.assignedToName,
    });
  } catch (err) {
    logger.error('Widget handoff history fetch failed', { tenantId: String(tenant._id), error: (err as Error).message });
    sendError(res, 'Could not load conversation history', 502);
  }
}

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Escapes regex-special characters in visitor-typed text before it's used
 * inside a MongoDB regex query (the City/State auto-match below) — without
 * this, a value like "St. Louis (Downtown)" would be interpreted as regex
 * syntax instead of literal text. */
/** Server-side re-validation of the submitted field VALUES against the
 * tenant's own saved field DEFINITIONS (Tenant.widget.connectBranch.fields)
 * — the client only ever sends `{key: value}`; which fields exist, which are
 * required, and what type each one is are never trusted from the request.
 * Returns a field-keyed error map, empty when everything passes. */
interface ConnectBranchFieldDef {
  key: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'dropdown';
  required: boolean;
  enabled: boolean;
}

function validateConnectBranchValues(
  fields: ConnectBranchFieldDef[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields ?? []) {
    // firstName is Lead's one hard-required field in the data model
    // (createLead() rejects without it) — always enforced here regardless
    // of what a saved config says, independent of the admin UI's own
    // "firstName can't be disabled/optional" lock, which only prevents this
    // from happening through the settings page itself.
    const isFirstName = field.key === 'firstName';
    if (!field.enabled && !isFirstName) continue;
    const raw = values[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if ((field.required || isFirstName) && !value) {
      errors[field.key] = `${field.label} is required`;
      continue;
    }
    if (!value) continue;
    if (field.type === 'email' && !EMAIL_FORMAT_REGEX.test(value)) {
      errors[field.key] = 'Enter a valid email address';
    } else if (field.type === 'phone' && !PHONE_FORMAT_REGEX.test(value)) {
      errors[field.key] = 'Enter a valid phone number';
    }
  }
  return errors;
}

/** A visitor submits the Connect-with-Branch form. Deterministic — no AI,
 * no live agent — creates a real Lead via the SAME
 * captureLeadFromExternalSource() pipeline the AI widget's own lead capture
 * already uses (round-robin staff assignment, PII encryption, automation
 * rules, and — because platform stays 'chatbot' — the existing chatbot
 * lead-confirmation + sales-alert emails, with zero new email code). City/
 * State are stored as plain fields on the Lead exactly as typed — no branch
 * lookup/attribution happens here. Completely independent of Human
 * Handoff — no ChatSession/socket state is touched here. */
export async function postConnectBranchSubmit(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }
  if (tenant.widget?.connectBranch?.enabled !== true) {
    sendError(res, 'Connect with Branch is not available for this widget', 403);
    return;
  }

  const tenantId = String(tenant._id);
  const { sessionId, visitorId, pageUrl, values } = req.body as {
    sessionId: string; visitorId?: string; pageUrl?: string; values: Record<string, string>;
  };

  try {
    const claim = await claimWidgetSession(tenantId, sessionId, 'connect_branch');
    if (!claim.claimed) {
      if (claim.outcome?.status === 'done') {
        sendSuccess(res, { ...claim.outcome.result, alreadyCreated: true }, 'Already submitted for this session');
      } else {
        sendError(res, 'This form is already being submitted — please wait a moment and try again', 409);
      }
      return;
    }

    const fieldErrors = validateConnectBranchValues(tenant.widget!.connectBranch!.fields, values ?? {});
    if (Object.keys(fieldErrors).length > 0) {
      await releaseWidgetSessionClaim(tenantId, sessionId, 'connect_branch');
      sendError(res, 'Please fix the highlighted fields', 400, { fieldErrors });
      return;
    }

    const firstName = (values.firstName || '').trim();
    const email     = (values.email || '').trim();
    const phone     = (values.phone || '').trim() || undefined;
    const company   = (values.company || '').trim() || undefined;
    const city      = (values.city || '').trim() || undefined;
    const state     = (values.state || '').trim() || undefined;
    const message   = (values.message || '').trim() || undefined;

    // Any field beyond the 7 built-ins (firstName/company/email/phone/
    // city/state/message) is a tenant-added custom field — its submitted
    // value is stored directly on Lead.customFields under its own key, the
    // exact shape the Lead edit/view screens already read customFields from
    // (`lead.customFields?.[cf.fieldKey]`), so a custom field configured
    // here shows up there once a matching NativeCustomField definition
    // exists for the 'leads' module (synced from the Widget Settings page).
    const BUILT_IN_FIELD_KEYS = new Set(['firstName', 'company', 'email', 'phone', 'city', 'state', 'message']);
    const customFieldValues: Record<string, string> = {};
    for (const field of tenant.widget!.connectBranch!.fields) {
      if (BUILT_IN_FIELD_KEYS.has(field.key) || !field.enabled) continue;
      const v = (values[field.key] || '').trim();
      if (v) customFieldValues[field.key] = v;
    }

    if (email && await hasRecentLeadForEmail(tenantId, email)) {
      await releaseWidgetSessionClaim(tenantId, sessionId, 'connect_branch');
      sendSuccess(res, { skipped: true, reason: 'recent_duplicate_email' }, 'A recent submission already exists for this email');
      return;
    }

    const assigned = await assignRoundRobin(
      tenantId,
      tenant.widget?.defaultTeamId ? String(tenant.widget.defaultTeamId) : undefined,
    );

    const { capture, lead } = await captureLeadFromExternalSource(
      tenantId, null, 'system:ai-widget-connect-branch', 'ai-widget@leadryze.internal',
      {
        platform: 'chatbot',
        sourceUrl: pageUrl || 'widget-connect-branch',
        raw: { firstName, email, phone, company },
        assignedStaffId: assigned?.staffId,
        assignedStaffName: assigned?.staffName,
        requirement: message,
        chatSessionId: sessionId,
        city,
        state,
        extraCustomFields: {
          _connectAction: 'branch',
          _capturePlatform: 'chatbot_connect_branch',
          ...customFieldValues,
        },
      },
    );

    if (!lead) {
      await releaseWidgetSessionClaim(tenantId, sessionId, 'connect_branch');
      sendError(res, capture.failureReason || 'Could not submit the form — please check your details and try again', 422);
      return;
    }

    const result = { leadId: String(lead._id) };
    await resolveWidgetSessionClaim(tenantId, sessionId, 'connect_branch', result);
    sendSuccess(res, result, 'Submitted');
  } catch (err) {
    logger.error('Connect-with-Branch submit failed', { tenantId, sessionId, error: (err as Error).message });
    try { await releaseWidgetSessionClaim(tenantId, sessionId, 'connect_branch'); } catch { /* best effort */ }
    sendError(res, 'Could not submit the form right now — please try again shortly', 502);
  }
}
