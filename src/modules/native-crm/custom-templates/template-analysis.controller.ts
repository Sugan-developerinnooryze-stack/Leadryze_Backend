import { Response } from 'express';
import axios from 'axios';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { config } from '../../../config';
import { TemplateDocType } from './custom-template.model';
import { NativeCustomField } from '../custom-fields/custom-field.model';
import { buildCatalogForDocType, MODULE_FOR_DOCTYPE } from '../pdf/variable-catalog';
import { repairAndValidateElements } from './template-analysis.repair';
import { TemplateAnalysisLog } from './template-analysis.model';
import { extractPdfStructure } from './pdf-structure-extractor';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The shared upload middleware also allows svg/ico/bmp (for other features'
// generic image uploads) — Claude's vision input only supports these exact
// mimetypes, so this feature validates more strictly than the generic filter.
const SUPPORTED_MIMETYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * POST / — upload an existing invoice/quotation/contract/workorder (PDF or
 * image), have the ai/ microservice analyze it, and return a repaired/
 * validated draft elements[] array. Deliberately does NOT create a
 * CustomTemplate — the draft stays unsaved until the user's own explicit
 * "Save Template" click, same as any brand-new blank template.
 */
export async function analyze(req: AuthRequest, res: Response) {
  try {
    if (!req.file) return sendError(res, 'file is required', 400);

    const mimetype = req.file.mimetype === 'image/jpg' ? 'image/jpeg' : req.file.mimetype;
    if (!SUPPORTED_MIMETYPES.has(mimetype)) {
      return sendError(res, `Unsupported file type "${req.file.mimetype}" — upload a PDF, JPEG, PNG, GIF, or WEBP.`, 400);
    }

    const docType = String(req.body.docType ?? '') as TemplateDocType;
    if (!MODULE_FOR_DOCTYPE[docType]) return sendError(res, 'Invalid docType', 400);

    const tenantId = req.tenantId!;

    // Mongo-backed daily quota — a backstop independent of the ai/ service's
    // Redis rate limiter, which fails OPEN (rate limiting silently disabled)
    // if Redis is unavailable. This is a paid, per-request AI call.
    const since = new Date(Date.now() - ONE_DAY_MS);
    const usedToday = await TemplateAnalysisLog.countDocuments({ tenantId, createdAt: { $gte: since } });
    if (usedToday >= config.ai.maxTemplateAnalysesPerDay) {
      return sendError(res, `Daily template-analysis limit reached (${config.ai.maxTemplateAnalysesPerDay}/day). Try again tomorrow.`, 429);
    }

    const customFieldDefs = await NativeCustomField.find({
      tenantId, module: MODULE_FOR_DOCTYPE[docType], isActive: true,
    }).select('fieldKey label fieldType').sort({ order: 1 }).lean();
    const variableCatalog = buildCatalogForDocType(docType, customFieldDefs);

    // Real digital PDFs (not scans) already contain every text run's exact
    // position/font as embedded data — reading it directly beats asking the
    // AI to visually reconstruct it from a picture. extractPdfStructure
    // returns null for scanned/photographed pages (no meaningful text
    // layer) or any parse failure, in which case this falls back to the
    // original full-document vision path unchanged.
    const structuredContent = mimetype === 'application/pdf'
      ? await extractPdfStructure(req.file.buffer)
      : null;

    let aiResponse;
    try {
      aiResponse = await axios.post(
        `${config.app.aiServiceUrl}/api/template-analysis`,
        structuredContent
          ? { tenantId, docType, structuredContent, variableCatalog }
          : { tenantId, docType, mimetype, fileBase64: req.file.buffer.toString('base64'), variableCatalog },
        { headers: { 'x-api-key': config.ai.internalApiKey }, timeout: 90000 },
      );
    } catch (err: any) {
      await TemplateAnalysisLog.create({
        tenantId, docType, mimetype, size: req.file.size,
        status: 'error', errorMessage: err.response?.data?.message ?? err.message,
      });
      const message = err.response?.data?.message ?? 'Document analysis failed — please try again';
      return sendError(res, message, err.response?.status ?? 502);
    }

    const { elements: rawElements } = aiResponse.data.data ?? {};
    const { elements, warnings } = repairAndValidateElements(rawElements, docType);

    await TemplateAnalysisLog.create({
      tenantId, docType, mimetype, size: req.file.size,
      status: 'success', warningsCount: warnings.length,
    });

    sendSuccess(res, { elements, warnings });
  } catch (err: any) {
    sendError(res, err.message ?? 'Analysis failed', 500);
  }
}
