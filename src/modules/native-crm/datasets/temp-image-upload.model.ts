import mongoose, { Schema, Document } from 'mongoose';

/**
 * Real-ownership tracking for a tenant-uploaded image ZIP, between the
 * two-step "upload ZIP -> get a ref -> include the ref in the JSON /import
 * call" flow (dataset-image import feature). The ZIP file itself lives on
 * disk (multer diskStorage, upload.middleware.ts's uploadZip) — this doc
 * only ever holds the temp path + who owns it, never the file bytes.
 *
 * `expiresAt` carries a TTL index so an abandoned upload's TRACKING DOC
 * expires on its own (MongoDB's native mechanism, not a hand-rolled check).
 * The TTL index only ever removes this doc, never the file on disk — the
 * orphaned-upload cron sweep (dataset-image-cleanup.cron.ts) is the second,
 * explicit half of cleanup that actually deletes the file, matching this
 * doc's own real ownership record rather than guessing from disk contents.
 */
export interface ITempImageUpload extends Document {
  ref: string;
  tenantId: mongoose.Types.ObjectId;
  createdBy: string;
  tempPath: string;
  originalFilename: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date;
}

const schema = new Schema<ITempImageUpload>({
  ref:              { type: String, required: true, unique: true, index: true },
  tenantId:         { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  createdBy:        { type: String, required: true },
  tempPath:         { type: String, required: true },
  originalFilename: { type: String, required: true },
  sizeBytes:        { type: Number, required: true },
  createdAt:        { type: Date, default: Date.now },
  expiresAt:        { type: Date, required: true },
});

// TTL index — MongoDB auto-deletes this doc once expiresAt passes. Real
// deletion of the FILE on disk is handled explicitly (processDatasetImages()'s
// own finally block on the happy/consumed path, the cron sweep on the
// abandoned path) — this index only ever cleans up the tracking record.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TempImageUpload = mongoose.model<ITempImageUpload>(
  'TempImageUpload',
  schema,
  'native_temp_image_uploads',
);
