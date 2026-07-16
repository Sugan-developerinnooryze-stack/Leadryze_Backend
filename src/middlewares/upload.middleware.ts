import multer from 'multer';
import path from 'path';

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
