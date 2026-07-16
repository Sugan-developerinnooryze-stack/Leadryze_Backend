import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as templateService from './template.service';
import { sendSuccess, sendCreated, sendError, sendPaginated } from '../../utils/response';

export async function createTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const template = await templateService.createTemplate(req.tenantId!, req.body);
    sendCreated(res, template, 'Template created');
  } catch (err) { next(err); }
}

export async function getTemplates(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { templates, total, page, limit } = await templateService.getTemplates(req.tenantId!, req.query as Record<string, unknown>);
    sendPaginated(res, templates, total, page, limit);
  } catch (err) { next(err); }
}

export async function getTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const template = await templateService.getTemplateById(req.tenantId!, req.params.id);
    if (!template) { sendError(res, 'Template not found', 404); return; }
    sendSuccess(res, template);
  } catch (err) { next(err); }
}

export async function updateTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const template = await templateService.updateTemplate(req.tenantId!, req.params.id, req.body);
    if (!template) { sendError(res, 'Template not found', 404); return; }
    sendSuccess(res, template, 'Template updated');
  } catch (err) { next(err); }
}

export async function deleteTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await templateService.deleteTemplate(req.tenantId!, req.params.id);
    sendSuccess(res, null, 'Template archived');
  } catch (err) { next(err); }
}

export async function seedTemplates(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await templateService.seedDefaultTemplates(req.tenantId!);
    sendSuccess(res, result, `Seeded ${result.created} default templates`);
  } catch (err) { next(err); }
}
