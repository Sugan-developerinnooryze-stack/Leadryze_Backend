import { Router, Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { NativeCustomFormTemplate } from './custom-form-template.model';
import mongoose from 'mongoose';

const router = Router();

/* GET /api/v1/native-crm/custom-form-templates */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const templates = await NativeCustomFormTemplate.find({ tenantId: tid }).sort({ name: 1 });
    sendSuccess(res, templates);
  } catch {
    sendError(res, 'Failed to fetch form templates', 500);
  }
});

/* POST /api/v1/native-crm/custom-form-templates */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const { name, description, fields } = req.body;
    if (!name?.trim()) return sendError(res, 'Name is required', 400);
    const template = await NativeCustomFormTemplate.create({ tenantId: tid, name: name.trim(), description, fields: fields ?? [] });
    sendSuccess(res, template, 'Form template created', 201);
  } catch {
    sendError(res, 'Failed to create form template', 500);
  }
});

/* PUT /api/v1/native-crm/custom-form-templates/:id */
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const { name, description, fields } = req.body;
    const template = await NativeCustomFormTemplate.findOneAndUpdate(
      { _id: req.params.id, tenantId: tid },
      { $set: { name, description, fields } },
      { new: true, runValidators: true }
    );
    if (!template) return sendError(res, 'Template not found', 404);
    sendSuccess(res, template, 'Form template updated');
  } catch {
    sendError(res, 'Failed to update form template', 500);
  }
});

/* DELETE /api/v1/native-crm/custom-form-templates/:id */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const template = await NativeCustomFormTemplate.findOneAndDelete({ _id: req.params.id, tenantId: tid });
    if (!template) return sendError(res, 'Template not found', 404);
    sendSuccess(res, null, 'Form template deleted');
  } catch {
    sendError(res, 'Failed to delete form template', 500);
  }
});

export default router;
