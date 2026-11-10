import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthRequest, JwtPayload, UserRole } from '../types';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';
import { logSecurityEvent } from '../modules/logs/security-event.model';
import { hasPermission } from '../modules/rbac/permission.service';
import { isCrmAssistantToken } from '../modules/ai/crm-assistant-token';
import { User } from '../modules/auth/auth.model';

/** LR-R26-SEC-002: an account that must change its password (a temporary
 * password from an invitation, provisioning or an admin reset) may only make
 * the calls the change-password screen needs until it has changed it. This
 * was enforced only by the browser's redirect, so the API worked with a
 * temporary password. */
const API = `/api/${config.app.apiVersion}`;
export const PASSWORD_CHANGE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  `${API}/auth/me`, `${API}/auth/change-password`, `${API}/auth/logout`, `${API}/roles/my-permissions`,
]);
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

function requestPath(req: AuthRequest): string {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** A token marked mustChangePassword, on any other call: allowed only if the
 * account has changed its password since the token was issued (the session
 * keeps its token after the change). Otherwise 403 with code
 * PASSWORD_CHANGE_REQUIRED. A failed lookup refuses the call. */
async function checkPasswordChanged(req: AuthRequest, res: Response, next: NextFunction, payload: JwtPayload): Promise<void> {
  try {
    const user = await User.findById(payload.userId).select('mustChangePassword').lean();
    if (!user) { sendError(res, 'Invalid or expired token', 401); return; }
    if (!user.mustChangePassword) {
      req.user = payload;
      req.tenantId = payload.tenantId;
      next();
      return;
    }
    logger.info('Request refused: password change required', { path: requestPath(req), userId: payload.userId });
    res.status(403).json({ success: false, message: 'Change your password to continue.', code: PASSWORD_CHANGE_REQUIRED });
  } catch (err) {
    logger.error('Password-change check failed', { userId: payload.userId, error: (err as Error).message });
    sendError(res, 'Could not verify your session. Please try again.', 503);
  }
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Access token required', 401);
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
    // The CRM assistant's internalAuth (aud "crm-assistant") is good only on
    // the internal CRM gateway, never as a login session here.
    if (isCrmAssistantToken(payload)) {
      logger.warn('Auth token verification failed', {
        reason:    'crm_assistant_audience',
        path:      req.path,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });
      logSecurityEvent('auth.token_invalid', {
        ip:        req.ip ?? 'unknown',
        userAgent: req.headers['user-agent'] ?? 'unknown',
        detail:    { path: req.path, reason: 'crm_assistant_audience' },
      });
      sendError(res, 'Invalid or expired token', 401);
      return;
    }
    if (payload.mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.has(requestPath(req))) {
      void checkPasswordChanged(req, res, next, payload);
      return;
    }
    req.user = payload;
    req.tenantId = payload.tenantId;
    next();
  } catch (err) {
    const isExpired = (err as Error).name === 'TokenExpiredError';
    logger.warn('Auth token verification failed', {
      reason:    isExpired ? 'expired' : 'invalid',
      path:      req.path,
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });
    logSecurityEvent(isExpired ? 'auth.token_expired' : 'auth.token_invalid', {
      ip:        req.ip ?? 'unknown',
      userAgent: req.headers['user-agent'] ?? 'unknown',
      detail:    { path: req.path, reason: isExpired ? 'expired' : 'invalid_signature' },
    });
    sendError(res, isExpired ? 'Token expired' : 'Invalid or expired token', 401);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) { sendError(res, 'Unauthorized', 401); return; }
    if (roles.length && !roles.includes(req.user.role)) {
      sendError(res, 'Insufficient permissions', 403);
      return;
    }
    next();
  };
}

/**
 * Database-driven permission check.
 * SUPER_ADMIN always passes.
 * TENANT_ADMIN without a roleId passes (legacy full-access — backward compat).
 * All other users are checked against their role's permission set in DB (Redis-cached).
 * Supports wildcard fallback: connector.zoho.accounts.view → connector.zoho.* → connector.*
 */
export function requirePermission(permissionKey: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const { role, roleId, tenantId } = req.user ?? {};

    if (role === 'SUPER_ADMIN') { next(); return; }
    if (role === 'TENANT_ADMIN') { next(); return; } // workspace owner — always full access

    if (!roleId || !tenantId) { sendError(res, 'Insufficient permissions', 403); return; }

    try {
      const allowed = await hasPermission(tenantId, roleId, permissionKey);
      if (allowed) { next(); return; }
      sendError(res, 'Insufficient permissions', 403);
    } catch (err) {
      logger.error('Permission check failed', { permissionKey, roleId, error: (err as Error).message });
      sendError(res, 'Permission check failed', 500);
    }
  };
}

/**
 * Same bypass/check contract as requirePermission(), for a route whose
 * target module is a URL param rather than fixed at route-registration time
 * (e.g. PDF generation's `/:module/:id` — the permission that applies
 * depends on which document type is being requested). Maps the param value
 * to `fs.<module>s.<tier>` (pluralizing unless already plural) — matches
 * every fs.* module key's own naming convention. */
export function requireModulePermission(paramName: string, tier: 'view' | 'edit') {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const { role, roleId, tenantId } = req.user ?? {};

    if (role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN') { next(); return; }
    if (!roleId || !tenantId) { sendError(res, 'Insufficient permissions', 403); return; }

    const moduleValue = req.params[paramName];
    const plural = moduleValue?.endsWith('s') ? moduleValue : `${moduleValue}s`;
    const permissionKey = `fs.${plural}.${tier}`;

    try {
      const allowed = await hasPermission(tenantId, roleId, permissionKey);
      if (allowed) { next(); return; }
      sendError(res, 'Insufficient permissions', 403);
    } catch (err) {
      logger.error('Permission check failed', { permissionKey, roleId, error: (err as Error).message });
      sendError(res, 'Permission check failed', 500);
    }
  };
}
