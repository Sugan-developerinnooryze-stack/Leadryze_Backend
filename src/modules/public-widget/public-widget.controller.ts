import { Request, Response } from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { config } from '../../config';
import { sendSuccess, sendError } from '../../utils/response';
import { logger } from '../../utils/logger';
import { resolveTenantByWidgetKey, isOriginAllowed } from './public-widget.service';
import { ITenant } from '../tenants/tenant.model';
import { ChatSession } from '../bot/chat-session.model';

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
    greeting:     tenant.widget?.greeting || 'Hi! How can I help you today?',
    language:     tenant.aiConfig?.language || 'en',
    template:     tenant.widget?.template || 'modern',
    voiceEnabled: !!tenant.widget?.voice?.enabled,
    voiceAutoPlay: tenant.widget?.voice?.autoPlay !== false,
    continuousVoiceEnabled: !!tenant.widget?.voice?.continuousModeEnabled,
    allowTextDuringVoice: tenant.widget?.voice?.allowTextDuringVoice !== false,
  });
}

export async function postChat(req: Request, res: Response): Promise<void> {
  const widgetKey = req.query.widgetKey as string;
  const tenant = await resolveTenantByWidgetKey(widgetKey);
  if (!tenant) { sendError(res, 'Widget not found or disabled', 404); return; }
  if (!applyCorsHeader(req, res, tenant)) { sendError(res, 'Origin not allowed for this widget', 403); return; }

  const { sessionId, visitorId, message, pageUrl } = req.body as {
    sessionId: string; visitorId?: string; message: string; pageUrl?: string;
  };

  try {
    // The EXISTING, unmodified AI /api/chat endpoint, called with the
    // EXISTING private internal key — identical shape to ai.routes.ts's own
    // (staff-authenticated) proxy. The public browser never sees this key
    // or talks to the AI service directly (see the plan's own "why the
    // browser must never call the AI service directly" section).
    const response = await axios.post(
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
    );
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

    const response = await axios.post(`${AI_URL}/api/voice/chat`, form, {
      headers: aiHeaders, timeout: 100000,
    });
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
