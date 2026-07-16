import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './meeting.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status } = req.query as Record<string, string>;
    const result = await svc.listMeetings(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
    });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch meetings', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getMeetingById(req.tenantId!, req.params.id);
    if (!record) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch meeting', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createMeeting(req.tenantId!, req.body);
    sendCreated(res, record, 'Meeting created');
  } catch { sendError(res, 'Failed to create meeting', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateMeeting(req.tenantId!, req.params.id, req.body);
    if (!record) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, record, 'Meeting updated');
  } catch { sendError(res, 'Failed to update meeting', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteMeeting(req.tenantId!, req.params.id);
    if (!ok) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, null, 'Meeting deleted');
  } catch { sendError(res, 'Failed to delete meeting', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getMeetingStats(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
