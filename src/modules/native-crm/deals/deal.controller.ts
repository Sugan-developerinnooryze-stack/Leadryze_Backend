import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './deal.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, stage } = req.query as Record<string, string>;
    const result = await svc.listDeals(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status: status ?? stage,
    }, req.branchId);
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch deals', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getDealById(req.tenantId!, req.params.id);
    if (!record) return void sendError(res, 'Deal not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch deal', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createDeal(req.tenantId!, { ...req.body, branchId: req.body.branchId ?? req.branchId ?? null });
    sendCreated(res, record, 'Deal created');
  } catch { sendError(res, 'Failed to create deal', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateDeal(req.tenantId!, req.params.id, req.body);
    if (!record) return void sendError(res, 'Deal not found', 404);
    sendSuccess(res, record, 'Deal updated');
  } catch { sendError(res, 'Failed to update deal', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteDeal(req.tenantId!, req.params.id);
    if (!ok) return void sendError(res, 'Deal not found', 404);
    sendSuccess(res, null, 'Deal deleted');
  } catch { sendError(res, 'Failed to delete deal', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getDealStats(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}

export async function updateStage(req: AuthRequest, res: Response) {
  try {
    const { stage } = req.body;
    if (!stage) return void sendError(res, 'stage is required', 400);
    const record = await svc.updateDeal(req.tenantId!, req.params.id, { stage });
    if (!record) return void sendError(res, 'Deal not found', 404);
    if (stage === 'closed_won') {
      autoLockIfConfigured(req.tenantId!, 'deals', (record as any)._id.toString(), 'closed_won', req.user?.userId ?? 'system').catch(() => {});
    }
    sendSuccess(res, record, 'Stage updated');
  } catch { sendError(res, 'Failed to update stage', 500); }
}
