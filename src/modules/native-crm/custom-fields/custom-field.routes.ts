import { Router } from 'express';
import * as ctrl from './custom-field.controller';
import { upload, uploadVideo, uploadMedia } from '../../../middlewares/upload.middleware';

const router = Router();

// ── Image upload (single + multiple) — 5 MB limit ───────────────────────────
router.post('/upload/image',
  upload.fields([
    { name: 'file',  maxCount: 1  },
    { name: 'files', maxCount: 20 },
  ]),
  ctrl.uploadImageFiles
);

// ── Video upload (single + multiple) — 10 MB limit ──────────────────────────
router.post('/upload/video',
  uploadVideo.fields([
    { name: 'file',  maxCount: 1 },
    { name: 'files', maxCount: 5 },
  ]),
  ctrl.uploadVideoFiles
);

// ── Legacy mixed endpoint (kept for compatibility) ──────────────────────────
router.post('/upload',
  uploadMedia.fields([
    { name: 'file',  maxCount: 1  },
    { name: 'files', maxCount: 10 },
  ]),
  ctrl.uploadMedia
);

// ── CRUD ────────────────────────────────────────────────────────────────────
router.get('/',       ctrl.list);
router.get('/:id',    ctrl.getOne);
router.post('/',      ctrl.create);
router.put('/:id',    ctrl.update);
router.delete('/:id', ctrl.remove);

export default router;
