import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getSettings, upsertSettings } from './fs-settings.service';
import { DocTemplatePreference } from './doc-template-preference.model';
import { uploadToS3 } from '../../../services/s3.service';

const DOC_TYPES = ['invoice', 'quotation', 'contract', 'workorder'] as const;
type DocType = typeof DOC_TYPES[number];

export async function get(req: AuthRequest, res: Response) {
  try {
    const settings = await getSettings(req.tenantId!, req.branchId ?? null);
    sendSuccess(res, settings ?? {});
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function upsert(req: AuthRequest, res: Response) {
  try {
    const settings = await upsertSettings(req.tenantId!, req.body, req.branchId ?? null);
    sendSuccess(res, settings);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function uploadFile(req: AuthRequest, res: Response) {
  try {
    if (!req.file) return sendError(res, 'No file uploaded', 400);
    const fileUrl = await uploadToS3({
      tenantId: req.tenantId!,
      folder:   'logos',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer:   req.file.buffer,
    });
    const fieldName = req.body.field as string | undefined;
    if (fieldName) {
      await upsertSettings(req.tenantId!, { [fieldName]: fileUrl }, req.branchId ?? null);
    }
    sendSuccess(res, { url: fileUrl, field: fieldName });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getTemplatePreferences(req: AuthRequest, res: Response) {
  try {
    const prefs = await DocTemplatePreference.find({
      tenantId: req.tenantId,
      branchId: req.branchId ?? null,
    }).lean();
    const result: Record<string, string> = {};
    for (const dt of DOC_TYPES) result[dt] = 'classic';
    for (const p of prefs) result[p.docType] = p.defaultVariant;
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function setTemplatePreferences(req: AuthRequest, res: Response) {
  try {
    const body = req.body as Partial<Record<DocType, string>>;
    type Variant = 'classic' | 'modern' | 'minimal';
    const VALID_VARIANTS: Variant[] = ['classic', 'modern', 'minimal'];
    const branchId = req.branchId ?? null;
    const ops = DOC_TYPES
      .filter(dt => body[dt] && VALID_VARIANTS.includes(body[dt] as Variant))
      .map(dt => ({
        updateOne: {
          filter: { tenantId: req.tenantId, docType: dt, branchId },
          update: { $set: { defaultVariant: body[dt] as Variant } },
          upsert: true,
        },
      }));
    if (ops.length) await DocTemplatePreference.bulkWrite(ops);
    const prefs = await DocTemplatePreference.find({ tenantId: req.tenantId, branchId }).lean();
    const result: Record<string, string> = {};
    for (const dt of DOC_TYPES) result[dt] = 'classic';
    for (const p of prefs) result[p.docType] = p.defaultVariant;
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
