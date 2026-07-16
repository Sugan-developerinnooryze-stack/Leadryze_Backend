import { Router } from 'express';
import { generatePdf } from './pdf.controller';

const router = Router();

router.get('/:module/:id', generatePdf);

export default router;
