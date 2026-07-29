import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import { listRules, createRule, updateRule, deleteRule, getFieldCatalog } from './automation-rule.service';
import { PipelineModule } from '../pipeline-config/pipeline-config.model';

export async function targetFields(req: AuthRequest, res: Response) {
  try {
    const module = req.query.module as string | undefined;
    if (!module) return sendError(res, 'module is required', 400);
    const fields = await getFieldCatalog(req.tenantId!, module as PipelineModule);
    sendSuccess(res, fields);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const items = await listRules(req.tenantId!, req.query.module as string | undefined);
    sendSuccess(res, items);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createRule(req.tenantId!, { ...req.body, createdBy: req.user?.userId });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateRule(req.tenantId!, req.params.id, req.body);
    if (!item) return sendError(res, 'Automation rule not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteRule(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Automation rule not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
