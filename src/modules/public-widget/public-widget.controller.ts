import { Request, Response } from 'express';
import axios from 'axios';
import { config } from '../../config';
import { sendSuccess, sendError } from '../../utils/response';
import { logger } from '../../utils/logger';
import { resolveTenantByWidgetKey, isOriginAllowed } from './public-widget.service';
import { ITenant } from '../tenants/tenant.model';

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
