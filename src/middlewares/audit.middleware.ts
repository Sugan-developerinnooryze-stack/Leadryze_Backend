import { Response, NextFunction } from 'express';
import { AuthRequest, AuditLogEntry } from '../types';
import { auditLogger } from '../utils/logger';

const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apiKey', 'accessToken', 'refreshToken'];

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const copy = { ...obj };
  SENSITIVE_KEYS.forEach((k) => { if (k in copy) copy[k] = '[REDACTED]'; });
  return copy;
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
      path: req.originalUrl,
      statusCode: res.statusCode,
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      payload: sanitize(req.body as Record<string, unknown>),
      duration: Date.now() - start,
      timestamp: new Date(),
    };
    auditLogger.info('API_ACTION', entry);
  });
  next();
}
