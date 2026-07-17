import { Router } from 'express';
import { generatePdf, shareDocumentEmail } from './pdf.controller';
import { validate } from '../../../middleware/validate.middleware';
import { shareEmailSchema } from './pdf.validation';

const router = Router();

router.get('/:module/:id', generatePdf);
router.post('/:module/:id/share-email', validate({ body: shareEmailSchema }), shareDocumentEmail);

export default router;
