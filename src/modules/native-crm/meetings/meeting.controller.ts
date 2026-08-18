import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './meeting.service';
import { resolveSupervisorName } from '../shared/team-resolution';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, relatedModule, relatedId, upcoming } = req.query as Record<string, string>;
    const result = await svc.listMeetings(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
      relatedModule, relatedId, upcoming: upcoming === 'true',
    }, resolveEffectiveScope(req, 'meetings'));
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch meetings', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getMeetingById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'meetings'));
    if (!record) return void sendError(res, 'Meeting not found', 404);
    // Live-resolved, never stored — a team's manager can change independently
    // of any given Meeting, so this is always read fresh, single-record only
    // (not on list responses, to avoid an N+1 join on every page load).
    const supervisorName = await resolveSupervisorName(req.tenantId!, (record as any).teamId);
    sendSuccess(res, { ...record, supervisorName });
  } catch { sendError(res, 'Failed to fetch meeting', 500); }
}

export async function reassignCandidates(req: AuthRequest, res: Response) {
  try {
    const result = await svc.getReassignCandidates(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'meetings'));
    if (!result) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, result);
  } catch { sendError(res, 'Failed to fetch reassignment candidates', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createMeeting(req.tenantId!, req.body);
    sendCreated(res, record, 'Meeting created');
  } catch (err: any) {
    if (err?.code === 11000) {
      sendError(res, 'That staff member already has a meeting at this exact time — please pick a different time or staff member.', 409);
      return;
    }
    sendError(res, 'Failed to create meeting', 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateMeeting(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'meetings'), req.user?.userId);
    if (!record) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, record, 'Meeting updated');
  } catch (err: any) {
    // A real, expected outcome — not a server fault — whenever a
    // reassignment (or any other update) would collide with the
    // {tenantId, assignedStaffId, startDate} partial-unique index (the same
    // double-booking guard the widget's own booking path already relies on).
    // Surfaced as a clean, actionable 409 instead of a generic 500, so the
    // Reassign UI can show the visitor-facing reason instead of a crash.
    if (err?.code === 11000) {
      sendError(res, 'That staff member already has a meeting at this exact time — please choose someone else or a different time.', 409);
      return;
    }
    sendError(res, 'Failed to update meeting', 500);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteMeeting(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'meetings'));
    if (!ok) return void sendError(res, 'Meeting not found', 404);
    sendSuccess(res, null, 'Meeting deleted');
  } catch { sendError(res, 'Failed to delete meeting', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getMeetingStats(req.tenantId!, resolveEffectiveScope(req, 'meetings'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
