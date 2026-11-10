import { Response, NextFunction } from 'express';
import { AuthRequest, AuditLogEntry } from '../types';
import { auditLogger } from '../utils/logger';

// internalAuth: the short-lived per-user JWT the AI service sends to the
// internal CRM gateway (/api/internal/crm-*) — in the body of writes and in
// the query string of reads. It must never land in a log.
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apiKey', 'accessToken', 'refreshToken', 'internalAuth'];

/** Query-string parameters whose values are replaced in a logged URL. */
const SENSITIVE_QUERY_PARAMS = ['internalAuth'];

export function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const copy = { ...obj };
  SENSITIVE_KEYS.forEach((k) => { if (k in copy) copy[k] = '[REDACTED]'; });
  return copy;
}

/* Decision D30: staff chat text, proposed record values and search terms
 * must not land in the 90-day audit log. On the CRM assistant's own routes
 * these body keys are redacted at any depth (on top of SENSITIVE_KEYS);
 * every other path is logged exactly as before. `summary` is the AI's
 * one-line description of a proposed change, which can repeat its values.
 * `handle`, `plan` and `search` (Increment 3): a table's re-run handle
 * (POST /api/v1/ai/crm-assist/view) carries the plan, whose search text and
 * condition values are the staff member's own words.
 * Increment 4: /execute carries the planner's `output` (values read from the
 * message) and the `clientContext` (the page and record on screen); a
 * planner `catalog`, should one ever be sent back, lists the tenant's own
 * stage and field labels. On the staff chat, a clarify choice (action
 * run_plan) carries a `plan` and the choice's `label`: choices and search
 * terms are staff text there too. Increment 6: a choice's or a record card's
 * write intent (action start) carries the `intent`, whose `values` and
 * `refs` are values and names the staff member typed; all three are redacted
 * on the staff chat too. */
const CRM_ASSIST_REDACTED_BODY_KEYS = [
  'values', 'lines', 'message', 'q', 'plannerOutput', 'intent', 'state', 'data', 'summary', 'handle', 'plan', 'search',
  'catalog', 'output', 'clientContext',
];
const CRM_CHAT_REDACTED_BODY_KEYS = ['message', 'plan', 'label', 'search', 'intent', 'values', 'refs'];
const MAX_REDACT_DEPTH = 8;

/** The body keys redacted for a request path (query string ignored, any
 * case, as Express routes it): the crm-assist routes (browser and internal)
 * and the staff chat. Empty for every other path. */
export function redactedBodyKeysFor(url: string): string[] {
  const path = (url || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (/^\/api\/v1\/ai\/crm-assist(\/|$)/.test(path) || /^\/api\/internal\/crm-assist(\/|$)/.test(path)) return CRM_ASSIST_REDACTED_BODY_KEYS;
  if (/^\/api\/v1\/ai\/crm-chat$/.test(path)) return CRM_CHAT_REDACTED_BODY_KEYS;
  return [];
}

function redactKeysDeep(value: unknown, keys: ReadonlySet<string>, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactKeysDeep(v, keys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = keys.has(k) ? '[REDACTED]' : redactKeysDeep(v, keys, depth + 1);
  }
  return out;
}

/** sanitize() plus the path-scoped redaction above. */
export function sanitizeForPath(obj: Record<string, unknown>, url: string): Record<string, unknown> {
  const base = sanitize(obj);
  const keys = redactedBodyKeysFor(url);
  return keys.length ? redactKeysDeep(base, new Set(keys), 0) as Record<string, unknown> : base;
}

/** `/api/internal/crm-list/t/lead?q=x&internalAuth=eyJ...` ->
 * `/api/internal/crm-list/t/lead?q=x&internalAuth=[REDACTED]` (any case,
 * any position in the query string). Everything else is left untouched. */
export function redactUrl(url: string): string {
  if (!url || !url.includes('?')) return url;
  let out = url;
  for (const param of SENSITIVE_QUERY_PARAMS) {
    out = out.replace(new RegExp(`([?&]${param}=)[^&#]*`, 'gi'), '$1[REDACTED]');
  }
  return out;
}

function resolveResource(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[2] || 'unknown';
}

function extractId(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return /^[a-f0-9]{24}$/.test(last) || /^[0-9a-f-]{36}$/i.test(last) ? last : undefined;
}

const ACTION_MAP: Record<string, string> = {
  GET: 'READ', POST: 'CREATE', PUT: 'UPDATE', PATCH: 'PARTIAL_UPDATE', DELETE: 'DELETE',
};

const AUDIT_EXCLUDED_PREFIXES = ['/health', '/api-docs', '/metrics', '/favicon'];

export function auditLog(req: AuthRequest, res: Response, next: NextFunction): void {
  if (AUDIT_EXCLUDED_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  const start = Date.now();
  res.on('finish', () => {
    const entry: AuditLogEntry = {
      tenantId: req.user?.tenantId || 'anonymous',
      userId: req.user?.userId || 'anonymous',
      action: ACTION_MAP[req.method] || req.method,
      resource: resolveResource(req.path),
      resourceId: extractId(req.path),
      method: req.method,
      path: redactUrl(req.originalUrl),
      statusCode: res.statusCode,
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      payload: sanitizeForPath(req.body as Record<string, unknown>, req.originalUrl || req.path),
      duration: Date.now() - start,
      timestamp: new Date(),
    };
    auditLogger.info('API_ACTION', entry);
  });
  next();
}
