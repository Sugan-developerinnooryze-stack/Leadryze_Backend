import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { config } from '../config';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';
import { logSecurityEvent } from '../modules/logs/security-event.model';

function logRateLimitViolation(req: Request): void {
  logger.warn('Rate limit exceeded', {
    ip:        req.ip,
    path:      req.path,
    method:    req.method,
    userAgent: req.headers['user-agent'],
  });
  logSecurityEvent('ratelimit.violation', {
    ip:        req.ip ?? 'unknown',
    userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
    detail:    { path: req.path, method: req.method },
  });
}

/** The AI service's calls to the CRM assistant engine
 * (/api/internal/crm-assist/*) with a valid service key: all of them come
 * from the AI service's one address, so the IP-keyed limit below would
 * throttle every staff member at once. They get their own per-user limit
 * (crmAssistInternalRateLimit) instead. Nothing else is exempt — the public
 * widget's traffic and every other internal route keep the IP limit. */
export function isServiceKeyedCrmAssistCall(req: Request): boolean {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!path.startsWith('/api/internal/crm-assist/')) return false;
  const key = req.headers['x-internal-key'];
  return typeof key === 'string' && !!key && key === config.ai.internalServiceKey;
}

export const globalRateLimit = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isServiceKeyedCrmAssistCall(req),
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many requests — please try again later.', 429);
  },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many auth attempts. Try again in 15 minutes.', 429);
  },
});

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Webhook rate limit exceeded', 429);
  },
});

/** Keyed by widgetKey (falling back to IP if somehow absent), not just IP —
 * layered on TOP of globalRateLimit (which already applies to every route,
 * IP-keyed), not instead of it. Reasoning: many visitors chatting through
 * one tenant's widget from behind a single office NAT shouldn't
 * collectively exhaust a budget meant to bound ONE tenant's traffic, and a
 * single abusive script hitting many different tenants' widgetKeys from one
 * IP is still caught by the existing IP-keyed globalRateLimit underneath. */
export const widgetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.query.widgetKey as string | undefined) || req.ip || 'unknown',
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many requests — please try again shortly', 429);
  },
});

/** Daily Events (the internal chat panel's read-only agenda) runs a few
 * dozen reads per request, so each signed-in user gets their own small
 * budget on top of the IP-keyed globalRateLimit. Must run after
 * authenticate (it keys on the verified user). */
export const dailyEventsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as Request & { user?: { tenantId?: string; userId?: string } }).user;
    return `daily-events:${user?.tenantId ?? 'none'}:${user?.userId ?? 'anonymous'}`;
  },
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Daily Events was refreshed too often — please wait a minute and try again.', 429);
  },
});

/** The staff chat assistant (POST /api/v1/ai/crm-chat): each signed-in user
 * gets their own budget on top of the IP-keyed globalRateLimit, like Daily
 * Events. Must run after authenticate (it keys on the verified user). */
export const crmChatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as Request & { user?: { tenantId?: string; userId?: string } }).user;
    return `crm-chat:${user?.tenantId ?? 'none'}:${user?.userId ?? 'anonymous'}`;
  },
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many assistant messages — please wait a minute and try again.', 429);
  },
});

/** The CRM assistant engine's internal routes (/api/internal/crm-assist/*):
 * 60 calls a minute per staff member, keyed on the identity verified from
 * the assistant token (res.locals.crmAssistIdentity), never on anything the
 * caller sends. Must run after that identity check. */
export const crmAssistInternalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => {
    const identity = (res.locals as { crmAssistIdentity?: { tenantId?: string; userId?: string } }).crmAssistIdentity;
    return `crm-assist:${identity?.tenantId ?? 'none'}:${identity?.userId ?? 'anonymous'}`;
  },
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many assistant requests for this user — please wait a minute.', 429);
  },
});

/** The CRM assistant's browser actions (POST /api/v1/ai/crm-assist/view:
 * sort, page or drop a filter of a chat table): 60 a minute per signed-in
 * user, on top of the IP-keyed globalRateLimit, with its own budget (one
 * store per limiter). Keyed on the verified tenant and user, so it must run
 * after authenticate. */
export const crmAssistActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as Request & { user?: { tenantId?: string; userId?: string } }).user;
    return `crm-assist-action:${user?.tenantId ?? 'none'}:${user?.userId ?? 'anonymous'}`;
  },
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many table changes — please wait a minute and try again.', 429);
  },
});

/** The CRM assistant's guided forms in the browser (POST
 * /api/v1/ai/crm-assist/operations/:id/validate, review, edit, cancel and
 * status, and /lookup for a form's record picker): 120 a minute per
 * signed-in user, on top of the IP-keyed globalRateLimit, with its own
 * budget (a form checks itself as the person types). Keyed on the verified
 * tenant and user, so it must run after authenticate. */
export const crmAssistFormRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as Request & { user?: { tenantId?: string; userId?: string } }).user;
    return `crm-assist-form:${user?.tenantId ?? 'none'}:${user?.userId ?? 'anonymous'}`;
  },
  handler: (req, res) => {
    logRateLimitViolation(req);
    sendError(res, 'Too many form changes. Wait a minute and try again.', 429);
  },
});
