import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './call.service';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, relatedModule, relatedId, upcoming } = req.query as Record<string, string>;
    const result = await svc.listCalls(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
      relatedModule, relatedId, upcoming: upcoming === 'true',
    }, resolveEffectiveScope(req, 'calls'));
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch calls', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getCallById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'calls'));
    if (!record) return void sendError(res, 'Call not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch call', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createCall(req.tenantId!, req.body);
    sendCreated(res, record, 'Call logged');
  } catch { sendError(res, 'Failed to log call', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateCall(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'calls'));
    if (!record) return void sendError(res, 'Call not found', 404);
    sendSuccess(res, record, 'Call updated');
  } catch { sendError(res, 'Failed to update call', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteCall(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'calls'));
    if (!ok) return void sendError(res, 'Call not found', 404);
    sendSuccess(res, null, 'Call deleted');
  } catch { sendError(res, 'Failed to delete call', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getCallStats(req.tenantId!, resolveEffectiveScope(req, 'calls'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
