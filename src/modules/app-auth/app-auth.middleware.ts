import { Request, Response, NextFunction } from 'express';
import { sendError } from '../../utils/response';
import { verifyAppToken, AppJwtPayload, AppUserType } from './app-auth.service';

export interface AppAuthRequest extends Request {
  appUser?: AppJwtPayload;
}

/**
 * Auth guard for staff/customer mobile-app tokens. These tokens are signed
 * with a separate secret, so admin tokens are rejected here and app tokens
 * are rejected by the main `authenticate` middleware — no privilege bleed.
 */
export function authenticateApp(...allowedTypes: AppUserType[]) {
  return (req: AppAuthRequest, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      sendError(res, 'Authentication required', 401);
      return;
    }
    try {
      const payload = verifyAppToken(header.slice(7));
      if (allowedTypes.length && !allowedTypes.includes(payload.type)) {
        sendError(res, 'Forbidden', 403);
        return;
      }
      req.appUser = payload;
      next();
    } catch {
      sendError(res, 'Invalid or expired token', 401);
    }
  };
}
