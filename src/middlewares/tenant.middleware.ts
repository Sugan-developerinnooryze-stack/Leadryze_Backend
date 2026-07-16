import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { sendError } from '../utils/response';

export function requireTenant(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user?.tenantId) {
    sendError(res, 'Tenant context required', 400);
    return;
  }
  req.tenantId = req.user.tenantId;
  next();
}
