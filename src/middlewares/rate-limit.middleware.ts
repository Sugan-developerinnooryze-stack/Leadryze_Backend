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

export const globalRateLimit = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
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
