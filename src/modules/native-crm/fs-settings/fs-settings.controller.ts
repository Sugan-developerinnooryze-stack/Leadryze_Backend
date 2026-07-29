import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getSettings, upsertSettings } from './fs-settings.service';
import { DocTemplatePreference, ITemplateSections, DEFAULT_TEMPLATE_SECTIONS } from './doc-template-preference.model';
import { uploadToS3 } from '../../../services/s3.service';

const DOC_TYPES = ['invoice', 'quotation', 'contract', 'workorder'] as const;
type DocType = typeof DOC_TYPES[number];
type Variant = 'classic' | 'modern' | 'minimal' | 'elegant';
const VALID_VARIANTS: Variant[] = ['classic', 'modern', 'minimal', 'elegant'];
const SECTION_KEYS: (keyof ITemplateSections)[] = ['services', 'parts', 'totals', 'notes', 'terms'];

interface TemplatePreferenceOut { variant: Variant; sections: ITemplateSections; }

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

function toOut(p: { defaultVariant: Variant; sections?: Partial<ITemplateSections> } | undefined): TemplatePreferenceOut {
  return {
    variant:  p?.defaultVariant ?? 'classic',
    sections: { ...DEFAULT_TEMPLATE_SECTIONS, ...(p?.sections ?? {}) },
  };
}

export async function getTemplatePreferences(req: AuthRequest, res: Response) {
  try {
    const prefs = await DocTemplatePreference.find({
      tenantId: req.tenantId,
      branchId: req.branchId ?? null,
    }).lean();
    const result: Record<string, TemplatePreferenceOut> = {};
    for (const dt of DOC_TYPES) result[dt] = toOut(undefined);
    for (const p of prefs) result[p.docType] = toOut(p);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function setTemplatePreferences(req: AuthRequest, res: Response) {
  try {
    const body = req.body as Partial<Record<DocType, { variant?: string; sections?: Partial<Record<string, boolean>> }>>;
    const branchId = req.branchId ?? null;
    const ops = DOC_TYPES
      .filter(dt => body[dt])
      .map(dt => {
        const entry = body[dt]!;
        const set: Record<string, unknown> = {};
        if (entry.variant && VALID_VARIANTS.includes(entry.variant as Variant)) {
          set.defaultVariant = entry.variant;
        }
        if (entry.sections && typeof entry.sections === 'object') {
          for (const key of SECTION_KEYS) {
            if (typeof entry.sections[key] === 'boolean') set[`sections.${key}`] = entry.sections[key];
          }
        }
        return { updateOne: { filter: { tenantId: req.tenantId, docType: dt, branchId }, update: { $set: set }, upsert: true } };
      })
      .filter(op => Object.keys(op.updateOne.update.$set).length > 0);
    if (ops.length) await DocTemplatePreference.bulkWrite(ops);
    const prefs = await DocTemplatePreference.find({ tenantId: req.tenantId, branchId }).lean();
    const result: Record<string, TemplatePreferenceOut> = {};
    for (const dt of DOC_TYPES) result[dt] = toOut(undefined);
    for (const p of prefs) result[p.docType] = toOut(p);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
