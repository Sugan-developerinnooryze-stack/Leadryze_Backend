import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../types';
import { getLockStatus } from './record-lock.service';
import { sendError } from '../../../utils/response';

const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

export function requireUnlocked(entityModule: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id;
      if (!id) return next();

      if (ADMIN_ROLES.includes(req.user?.role ?? '')) return next();

      const status = await getLockStatus(req.tenantId!, entityModule, id);
      if (!status.isLocked) return next();

      sendError(
        res,
        `This record is locked: "${status.lockReason}". Contact an administrator to unlock.`,
        423,
      );
    } catch {
      next();
    }
  };
}
