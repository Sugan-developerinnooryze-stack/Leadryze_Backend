import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import {
  lockRecord,
  unlockRecord,
  getLockStatus,
  getLockAudit,
  getTenantLockAudit,
} from './record-lock.service';

const VALID_MODULES = ['leads','customers','contacts','deals','invoices','contracts','quotations','workorders'];

function validateModule(module: string, res: Response): boolean {
  if (!VALID_MODULES.includes(module)) {
    sendError(res, `Unknown module: ${module}`, 400);
    return false;
  }
  return true;
}

export async function lock(req: AuthRequest, res: Response): Promise<void> {
  const { module, id } = req.params;
  if (!validateModule(module, res)) return;
  const { reason } = req.body as { reason?: string };
  if (!reason || reason.trim().length < 5) {
    sendError(res, 'reason is required (min 5 characters)', 422);
    return;
  }
  try {
    await lockRecord(req.tenantId!, module, id, req.user!.userId, reason.trim());
    sendSuccess(res, { module, entityId: id, locked: true }, 'Record locked');
  } catch (err: any) {
    sendError(res, err.message, 409);
  }
}

export async function unlock(req: AuthRequest, res: Response): Promise<void> {
  const { module, id } = req.params;
  if (!validateModule(module, res)) return;
  const { reason } = req.body as { reason?: string };
  if (!reason || reason.trim().length < 5) {
    sendError(res, 'reason is required (min 5 characters)', 422);
    return;
  }
  try {
    await unlockRecord(req.tenantId!, module, id, req.user!.userId, reason.trim());
    sendSuccess(res, { module, entityId: id, locked: false }, 'Record unlocked');
  } catch (err: any) {
    sendError(res, err.message, 409);
  }
}

export async function status(req: AuthRequest, res: Response): Promise<void> {
  const { module, id } = req.params;
  if (!validateModule(module, res)) return;
  try {
    const result = await getLockStatus(req.tenantId!, module, id);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

export async function audit(req: AuthRequest, res: Response): Promise<void> {
  const { module, id } = req.params;
  if (!validateModule(module, res)) return;
  try {
    const entries = await getLockAudit(req.tenantId!, module, id);
    sendSuccess(res, entries);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function tenantAudit(req: AuthRequest, res: Response): Promise<void> {
  const { module, page, limit } = req.query as Record<string, string | undefined>;
  try {
    const result = await getTenantLockAudit(req.tenantId!, {
      module,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
