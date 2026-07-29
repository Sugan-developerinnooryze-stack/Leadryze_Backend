import { Router } from 'express';
import { z } from 'zod';
import { generatePdf, shareDocumentEmail, previewHtml, previewDraftHtml, downloadDraftPdf, getLiveData } from './pdf.controller';
import { validate } from '../../../middleware/validate.middleware';
import { shareEmailSchema } from './pdf.validation';
import { designElementSchema, templateRegionSchema } from '../custom-templates/custom-template.validation';

const previewDraftSchema = z.object({
  elements: z.array(designElementSchema).max(200),
  page: z.object({
    marginTopPx:    z.number().min(0).max(200),
    marginBottomPx: z.number().min(0).max(200),
  }).optional(),
  header: templateRegionSchema.optional(),
  footer: templateRegionSchema.optional(),
});

const router = Router();

router.get('/:module/:id', generatePdf);
router.get('/:module/:id/live-data',     getLiveData);
router.get('/:module/:id/preview-html',  previewHtml);
router.post('/:module/:id/preview-html', validate({ body: previewDraftSchema }), previewDraftHtml);
router.post('/:module/:id/download-draft', validate({ body: previewDraftSchema }), downloadDraftPdf);
router.post('/:module/:id/share-email',  validate({ body: shareEmailSchema }),  shareDocumentEmail);

export default router;
