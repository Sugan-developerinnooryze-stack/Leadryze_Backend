import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { CustomTemplate } from './custom-template.model';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { docType } = req.query;
    const filter: any = { tenantId: req.tenantId };
    if (docType) filter.docType = docType;
    const templates = await CustomTemplate.find(filter).sort({ createdAt: -1 }).lean();
    sendSuccess(res, templates);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId }).lean();
    if (!t) return sendError(res, 'Not found', 404);
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const { name, docType, elements, isDefault } = req.body;
    if (!name || !docType) return sendError(res, 'name and docType are required', 400);
    if (isDefault) {
      await CustomTemplate.updateMany(
        { tenantId: req.tenantId, docType },
        { $set: { isDefault: false } }
      );
    }
    const t = await CustomTemplate.create({ tenantId: req.tenantId, name, docType, elements: elements ?? [], isDefault: !!isDefault });
    res.status(201).json({ success: true, data: t });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const { name, elements, isDefault } = req.body;
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    if (isDefault) {
      await CustomTemplate.updateMany(
        { tenantId: req.tenantId, docType: t.docType, _id: { $ne: t._id } },
        { $set: { isDefault: false } }
      );
    }
    if (name      !== undefined) t.name      = name;
    if (elements  !== undefined) t.elements  = elements;
    if (isDefault !== undefined) t.isDefault = isDefault;
    await t.save();
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    sendSuccess(res, null, 'Deleted');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function setDefault(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    await CustomTemplate.updateMany(
      { tenantId: req.tenantId, docType: t.docType },
      { $set: { isDefault: false } }
    );
    t.isDefault = true;
    await t.save();
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
