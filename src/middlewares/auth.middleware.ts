import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthRequest, JwtPayload, UserRole } from '../types';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';
import { logSecurityEvent } from '../modules/logs/security-event.model';
import { hasPermission } from '../modules/rbac/permission.service';

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Access token required', 401);
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
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
