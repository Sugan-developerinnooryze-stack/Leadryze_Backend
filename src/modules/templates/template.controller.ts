import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as templateService from './template.service';
import { TemplateActionError } from './template.service';
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

export async function activateTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const template = await templateService.activateTemplate(req.tenantId!, req.params.id);
    if (!template) { sendError(res, 'Template not found', 404); return; }
    sendSuccess(res, template, 'Template activated');
  } catch (err) { next(err); }
}

export async function duplicateTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const template = await templateService.duplicateTemplate(req.tenantId!, req.params.id);
    if (!template) { sendError(res, 'Template not found', 404); return; }
    sendCreated(res, template, 'Template duplicated');
  } catch (err) { next(err); }
}

export async function previewTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const preview = await templateService.previewTemplate(req.tenantId!, req.params.id, req.body?.sampleVariables);
    if (!preview) { sendError(res, 'Template not found', 404); return; }
    sendSuccess(res, preview);
  } catch (err) { next(err); }
}

export async function testSendTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await templateService.testSendTemplate(req.tenantId!, req.params.id, req.body.to);
    sendSuccess(res, result, result.sent ? 'Test message sent' : (result.reason ?? 'Test message could not be sent'));
  } catch (err) {
    if (err instanceof TemplateActionError) { sendError(res, err.message, err.status); return; }
    next(err);
  }
}

export async function getTemplateUsage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const usage = await templateService.getTemplateUsage(req.tenantId!, req.params.id);
    sendSuccess(res, usage);
  } catch (err) { next(err); }
}
