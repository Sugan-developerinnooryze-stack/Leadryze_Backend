import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { WorkflowTemplate } from './workflow-template.model';

const router = Router();

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const items = await WorkflowTemplate.find({ tenantId: tid }).sort({ createdAt: 1 });
    sendSuccess(res, { items });
  } catch {
    sendError(res, 'Failed to list workflow templates', 500);
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const doc = await WorkflowTemplate.create({ ...req.body, tenantId: tid });
    sendSuccess(res, doc, 'Created successfully', 201);
  } catch {
    sendError(res, 'Failed to create workflow template', 500);
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    const doc = await WorkflowTemplate.findOneAndUpdate(
      { _id: req.params.id, tenantId: tid },
      req.body,
      { new: true, runValidators: true }
    );
    if (!doc) return sendError(res, 'Not found', 404);
    sendSuccess(res, doc);
  } catch {
    sendError(res, 'Failed to update workflow template', 500);
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    await WorkflowTemplate.findOneAndDelete({ _id: req.params.id, tenantId: tid });
    sendSuccess(res, { deleted: true });
  } catch {
    sendError(res, 'Failed to delete workflow template', 500);
  }
});

router.put('/:id/set-default', async (req: AuthRequest, res: Response) => {
  try {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    await WorkflowTemplate.updateMany({ tenantId: tid }, { isDefault: false });
    const doc = await WorkflowTemplate.findOneAndUpdate(
      { _id: req.params.id, tenantId: tid },
      { isDefault: true },
      { new: true }
    );
    if (!doc) return sendError(res, 'Not found', 404);
    sendSuccess(res, doc);
  } catch {
    sendError(res, 'Failed to set default template', 500);
  }
});

export default router;
