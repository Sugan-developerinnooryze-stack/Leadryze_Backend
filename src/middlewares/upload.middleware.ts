import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const imageFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;
  
  if (mime.startsWith('image/') || mime === 'application/pdf' || /jpeg|jpg|png|gif|webp|pdf|svg|ico|bmp/.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Only image and PDF files are allowed. Received: ${mime} (ext: ${ext})`));
  }
};

const videoFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = /mp4|webm|ogg|mov|quicktime/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const mime = file.mimetype;
  if (allowed.test(ext) || mime.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video files are allowed (mp4, webm, mov, ogg)'));
  }
};

const audioFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Covers MediaRecorder's actual cross-browser output (chiefly webm/opus on
  // Chrome/Firefox, mp4/aac on Safari) plus a few generic fallbacks.
  const allowed = /webm|mp4|ogg|wav|m4a|mpeg|mpga/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (allowed.test(ext) || file.mimetype.startsWith('audio/')) {
    cb(null, true);
  } else {
    cb(new Error(`Only audio files are allowed. Received: ${file.mimetype}`));
  }
};

const mediaFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const imgAllowed = /jpeg|jpg|png|gif|webp|svg|pdf/;
  const vidAllowed = /mp4|webm|ogg|mov|quicktime/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (imgAllowed.test(ext) || vidAllowed.test(ext) || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image and video files are allowed'));
  }
};

// Images / PDFs — 5 MB limit
export const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

// Same as upload — alias kept for backwards compat
export const uploadMemory = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

// Videos only — 10 MB limit
export const uploadVideo = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: videoFilter,
});

// Mixed media (images + videos) — 10 MB ceiling; controller enforces 5 MB for images
export const uploadMedia = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: mediaFilter,
});

// Voice-widget recordings — 5 MB limit (comfortably covers a 60s clip at
// typical opus bitrates; the widget's own recorder additionally auto-stops
// at 60s client-side as the primary duration guard, this is defense-in-depth).
export const uploadAudio = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: audioFilter,
});

// Dataset image-import ZIP — disk-backed (never memory/Redis, a 200MB ZIP
// has no business sitting in application memory), random non-guessable
// filename (never the client's original filename), 200MB ceiling. Real
// ownership tracking (TempImageUpload) and cleanup happen in
// dataset-image.service.ts, not here — this middleware only ever gets the
// file safely onto disk.
export const DATASET_IMAGE_ZIP_TEMP_DIR = path.join(process.cwd(), 'tmp', 'dataset-image-imports');
fs.mkdirSync(DATASET_IMAGE_ZIP_TEMP_DIR, { recursive: true });

const zipFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;
  if (ext === '.zip' && (mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime === 'application/octet-stream')) {
    cb(null, true);
  } else {
    cb(new Error(`Only .zip files are allowed. Received: ${mime} (ext: ${ext})`));
  }
};

export const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, DATASET_IMAGE_ZIP_TEMP_DIR),
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: zipFilter,
});
