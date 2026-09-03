import { Router } from 'express';
import * as ctrl from './custom-field.controller';
import { upload, uploadVideo, uploadMedia } from '../../../middlewares/upload.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

// Reuses the existing fs.custom_fields.* tier (already defined for FS
// Settings' own custom-field management) rather than a new key — same
// tenant-wide "define what fields exist" concern, not a separate one.

// ── Image upload (single + multiple) — 5 MB limit ───────────────────────────
router.post('/upload/image',
  requirePermission('fs.custom_fields.manage'),
  upload.fields([
    { name: 'file',  maxCount: 1  },
    { name: 'files', maxCount: 20 },
  ]),
  ctrl.uploadImageFiles
);

// ── Video upload (single + multiple) — 10 MB limit ──────────────────────────
router.post('/upload/video',
  requirePermission('fs.custom_fields.manage'),
  uploadVideo.fields([
    { name: 'file',  maxCount: 1 },
    { name: 'files', maxCount: 5 },
  ]),
  ctrl.uploadVideoFiles
);

// ── Legacy mixed endpoint (kept for compatibility) ──────────────────────────
router.post('/upload',
  requirePermission('fs.custom_fields.manage'),
  uploadMedia.fields([
    { name: 'file',  maxCount: 1  },
    { name: 'files', maxCount: 10 },
  ]),
  ctrl.uploadMedia
);

// ── CRUD ────────────────────────────────────────────────────────────────────
router.get('/',       requirePermission('fs.custom_fields.view'),   ctrl.list);
router.get('/:id',    requirePermission('fs.custom_fields.view'),   ctrl.getOne);
router.post('/',      requirePermission('fs.custom_fields.manage'), ctrl.create);
router.put('/:id',    requirePermission('fs.custom_fields.manage'), ctrl.update);
router.delete('/:id', requirePermission('fs.custom_fields.manage'), ctrl.remove);

export default router;
