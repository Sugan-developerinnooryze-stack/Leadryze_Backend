import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import { listTemplates, getTemplateById, createTemplate, deleteTemplate } from './automation-template.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const items = await listTemplates(req.tenantId!);
    sendSuccess(res, items);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getTemplateById(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Template not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

// "Save as template" — body is {sourceFlowId, name, description?, category?},
// never raw nodes/edges (see automation-template.service.ts's createTemplate
// for the ownership-checked fetch this relies on).
export async function create(req: AuthRequest, res: Response) {
  try {
    const { sourceFlowId, name, description, category } = req.body;
    if (!sourceFlowId || !name) return sendError(res, 'sourceFlowId and name are required', 400);
    const item = await createTemplate(req.tenantId!, sourceFlowId, name, description, category);
    if (!item) return sendError(res, 'Source flow not found', 404);
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteTemplate(req.tenantId!, req.params.id);
    if (!item) return sendError(res, 'Template not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
