import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './task.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { resolveEffectiveScope } from '../shared/data-scope';
import { logTimeline } from '../timeline/timeline.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, relatedModule, relatedId, upcoming } = req.query as Record<string, string>;
    const result = await svc.listTasks(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
      relatedModule, relatedId, upcoming: upcoming === 'true',
    }, req.branchId, resolveEffectiveScope(req, 'tasks'));
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch tasks', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getTaskById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tasks'));
    if (!record) return void sendError(res, 'Task not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch task', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createTask(req.tenantId!, {
      ...req.body,
      branchId: req.body.branchId ?? req.branchId ?? null,
    });
    logTimeline(req.tenantId!, 'task', String((record as any)._id), 'created', `Task "${(record as any).title}" created`, req.user?.userId,
      { taskStatus: (record as any).taskStatus, dueDate: (record as any).dueDate }).catch(() => {});
    runAutomationsOnCreate(req.tenantId!, 'task', record as any).catch(() => {});
    sendCreated(res, record, 'Task created');
  } catch { sendError(res, 'Failed to create task', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await svc.getTaskById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tasks'));
    const record = await svc.updateTask(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'tasks'));
    if (!record) return void sendError(res, 'Task not found', 404);
    const statusChanged = req.body.taskStatus && prev && (prev as any).taskStatus !== req.body.taskStatus;
    logTimeline(
      req.tenantId!, 'task', String((record as any)._id), statusChanged ? 'status_changed' : 'updated',
      statusChanged ? `Status changed to ${req.body.taskStatus}` : `Task "${(record as any).title}" updated`,
      req.user?.userId,
      statusChanged ? { previousStatus: (prev as any).taskStatus, newStatus: req.body.taskStatus } : undefined,
    ).catch(() => {});
    if (req.body.taskStatus) runAutomations(req.tenantId!, 'task', record as any, req.body.taskStatus).catch(() => {});
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'task', prev, record as any).catch(() => {});
    sendSuccess(res, record, 'Task updated');
  } catch { sendError(res, 'Failed to update task', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const record = await svc.deleteTask(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tasks'));
    if (!record) return void sendError(res, 'Task not found', 404);
    logTimeline(req.tenantId!, 'task', req.params.id, 'deleted', `Task "${(record as any).title}" deleted`, req.user?.userId,
      { taskStatus: (record as any).taskStatus }).catch(() => {});
    runAutomationsOnDelete(req.tenantId!, 'task', record as any).catch(() => {});
    sendSuccess(res, null, 'Task deleted');
  } catch { sendError(res, 'Failed to delete task', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getTaskStats(req.tenantId!, req.branchId, resolveEffectiveScope(req, 'tasks'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
