import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './task.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, relatedModule, relatedId, upcoming } = req.query as Record<string, string>;
    const result = await svc.listTasks(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
      relatedModule, relatedId, upcoming: upcoming === 'true',
    }, resolveEffectiveScope(req, 'tasks'));
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
    const record = await svc.createTask(req.tenantId!, req.body);
    runAutomationsOnCreate(req.tenantId!, 'task', record as any).catch(() => {});
    sendCreated(res, record, 'Task created');
  } catch { sendError(res, 'Failed to create task', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await svc.getTaskById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tasks'));
    const record = await svc.updateTask(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'tasks'));
    if (!record) return void sendError(res, 'Task not found', 404);
    if (req.body.taskStatus) runAutomations(req.tenantId!, 'task', record as any, req.body.taskStatus).catch(() => {});
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'task', prev, record as any).catch(() => {});
    sendSuccess(res, record, 'Task updated');
  } catch { sendError(res, 'Failed to update task', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const record = await svc.deleteTask(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'tasks'));
    if (!record) return void sendError(res, 'Task not found', 404);
    runAutomationsOnDelete(req.tenantId!, 'task', record as any).catch(() => {});
    sendSuccess(res, null, 'Task deleted');
  } catch { sendError(res, 'Failed to delete task', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getTaskStats(req.tenantId!, resolveEffectiveScope(req, 'tasks'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
