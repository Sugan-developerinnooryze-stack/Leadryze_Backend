import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './deal.service';
import { autoLockIfConfigured } from '../record-lock/record-lock.service';
import { getOutcomeStageKey } from '../pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../automation-rules/automation-rule.service';
import { resolveEffectiveScope } from '../shared/data-scope';
import { logTimeline } from '../timeline/timeline.service';
import { logAuditEvent } from '../../logs/audit-log.model';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, stage, sortBy, sortDir, customFieldFilters } = req.query as Record<string, string>;
    const result = await svc.listDeals(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status: status ?? stage,
      sortBy, sortDir: sortDir as 'asc' | 'desc' | undefined, customFieldFilters,
    }, req.branchId, resolveEffectiveScope(req, 'deals'));
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch deals', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getDealById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'deals'));
    if (!record) return void sendError(res, 'Deal not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch deal', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createDeal(req.tenantId!, { ...req.body, branchId: req.body.branchId ?? req.branchId ?? null });
    logTimeline(req.tenantId!, 'deal', String(record._id), 'created', `Deal "${(record as any).title}" created`, req.user?.userId,
      { stage: (record as any).stage, amount: (record as any).amount }).catch(() => {});
    runAutomationsOnCreate(req.tenantId!, 'deal', record as any).catch(() => {});
    sendCreated(res, record, 'Deal created');
  } catch (err: any) { sendError(res, err.message ?? 'Failed to create deal', 400); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const prev = await svc.getDealById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'deals'));
    const record = await svc.updateDeal(req.tenantId!, req.params.id, req.body, resolveEffectiveScope(req, 'deals'));
    if (!record) return void sendError(res, 'Deal not found', 404);
    const stageChanged = req.body.stage && prev && (prev as any).stage !== req.body.stage;
    logTimeline(
      req.tenantId!, 'deal', String(record._id), stageChanged ? 'stage_changed' : 'updated',
      stageChanged ? `Stage changed to ${req.body.stage}` : `Deal "${(record as any).title}" updated`,
      req.user?.userId,
      stageChanged ? { previousStage: (prev as any).stage, newStage: req.body.stage } : { amount: (record as any).amount },
    ).catch(() => {});
    if (req.body.stage) runAutomations(req.tenantId!, 'deal', record, req.body.stage).catch(() => {});
    if (prev) runAutomationsOnUpdate(req.tenantId!, 'deal', prev, record).catch(() => {});
    sendSuccess(res, record, 'Deal updated');
  } catch (err: any) { sendError(res, err.message ?? 'Failed to update deal', 400); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const record = await svc.deleteDeal(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'deals'));
    if (!record) return void sendError(res, 'Deal not found', 404);
    logTimeline(req.tenantId!, 'deal', req.params.id, 'deleted', `Deal "${(record as any).title}" deleted`, req.user?.userId,
      { stage: (record as any).stage, amount: (record as any).amount }).catch(() => {});
    runAutomationsOnDelete(req.tenantId!, 'deal', record).catch(() => {});
    logAuditEvent('deal.deleted',
      { id: req.user!.userId, email: req.user!.email, role: req.user!.role, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
      { tenantId: req.tenantId!, target: 'Deal', targetId: req.params.id, detail: { before: { title: (record as any).title, stage: (record as any).stage, amount: (record as any).amount } } },
    );
    sendSuccess(res, null, 'Deal deleted');
  } catch { sendError(res, 'Failed to delete deal', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getDealStats(req.tenantId!, resolveEffectiveScope(req, 'deals'))); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}

export async function updateStage(req: AuthRequest, res: Response) {
  try {
    const { stage } = req.body;
    if (!stage) return void sendError(res, 'stage is required', 400);
    const prev = await svc.getDealById(req.tenantId!, req.params.id, resolveEffectiveScope(req, 'deals'));
    const record = await svc.updateDeal(req.tenantId!, req.params.id, { stage }, resolveEffectiveScope(req, 'deals'));
    if (!record) return void sendError(res, 'Deal not found', 404);
    logTimeline(req.tenantId!, 'deal', String((record as any)._id), 'stage_changed', `Stage changed to ${stage}`, req.user?.userId,
      { previousStage: (prev as any)?.stage, newStage: stage }).catch(() => {});
    const wonKey = await getOutcomeStageKey(req.tenantId!, 'deal', 'won', 'closed_won');
    if (stage === wonKey) {
      autoLockIfConfigured(req.tenantId!, 'deals', (record as any)._id.toString(), wonKey, req.user?.userId ?? 'system').catch(() => {});
    }
    runAutomations(req.tenantId!, 'deal', record as any, stage).catch(() => {});
    sendSuccess(res, record, 'Stage updated');
  } catch (err: any) { sendError(res, err.message ?? 'Failed to update stage', 400); }
}
