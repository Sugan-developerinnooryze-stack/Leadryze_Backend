import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './task.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status } = req.query as Record<string, string>;
    const result = await svc.listTasks(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
    });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch tasks', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getTaskById(req.tenantId!, req.params.id);
    if (!record) return void sendError(res, 'Task not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch task', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createTask(req.tenantId!, req.body);
    sendCreated(res, record, 'Task created');
  } catch { sendError(res, 'Failed to create task', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateTask(req.tenantId!, req.params.id, req.body);
    if (!record) return void sendError(res, 'Task not found', 404);
    sendSuccess(res, record, 'Task updated');
  } catch { sendError(res, 'Failed to update task', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteTask(req.tenantId!, req.params.id);
    if (!ok) return void sendError(res, 'Task not found', 404);
    sendSuccess(res, null, 'Task deleted');
  } catch { sendError(res, 'Failed to delete task', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getTaskStats(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
