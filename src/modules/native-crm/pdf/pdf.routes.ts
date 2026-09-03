import { Router } from 'express';
import { z } from 'zod';
import { generatePdf, shareDocumentEmail, previewHtml, previewDraftHtml, downloadDraftPdf, getLiveData } from './pdf.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requireModulePermission } from '../../../middlewares/auth.middleware';
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

// Share-email is edit-tier — it emails the document to an arbitrary
// recipient, an action, not a plain read, same reasoning as portal.routes.ts's
// own generate-token gating.
router.get('/:module/:id', requireModulePermission('module', 'view'), generatePdf);
router.get('/:module/:id/live-data',     requireModulePermission('module', 'view'), getLiveData);
router.get('/:module/:id/preview-html',  requireModulePermission('module', 'view'), previewHtml);
router.post('/:module/:id/preview-html', requireModulePermission('module', 'view'), validate({ body: previewDraftSchema }), previewDraftHtml);
router.post('/:module/:id/download-draft', requireModulePermission('module', 'view'), validate({ body: previewDraftSchema }), downloadDraftPdf);
router.post('/:module/:id/share-email',  requireModulePermission('module', 'edit'), validate({ body: shareEmailSchema }),  shareDocumentEmail);

export default router;
