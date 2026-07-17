import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config';

export const s3Client = new S3Client({
  endpoint:        config.s3.endpoint,
  region:          config.s3.region,
  credentials: {
    accessKeyId:     config.s3.keyId,
    secretAccessKey: config.s3.secret,
  },
  forcePathStyle: true, // required for Supabase S3
});

/**
 * Build the S3 object key for a tenant file.
 * Pattern: Leadryze_Bucket/{tenantId}/{folder}/{timestamp}-{sanitized-filename}
 * All files will go inside the "Leadryze_Bucket" folder.
 */
export function buildKey(tenantId: string, folder: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `Leadryze_Bucket/${tenantId}/${folder}/${Date.now()}-${safe}`;
}

/**
 * Resolve this backend's own public base URL.
 * - BACKEND_URL: explicit, always wins if set (works for any host).
 * - RENDER_EXTERNAL_URL: auto-injected by Render on web services at runtime —
 *   covers deployments where BACKEND_URL was never configured.
 * - Falls back to localhost only for local dev.
 */
function resolveBaseUrl(): string {
  return process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${config.app.port}`;
}

/**
 * Build the public URL for a given S3 key by pointing it to our backend proxy route.
 * Format: {BACKEND_URL}/api/v1/storage/{key}
 */
export function buildPublicUrl(key: string): string {
  return `${resolveBaseUrl()}/api/${config.app.apiVersion}/storage/${key}`;
}

/**
 * Upload a file buffer to S3. Returns the proxy public URL.
 */
export async function uploadToS3(params: {
  tenantId: string;
  folder:   string;
  filename: string;
  mimetype: string;
  buffer:   Buffer;
}): Promise<string> {
  const key = buildKey(params.tenantId, params.folder, params.filename);

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket:      config.s3.bucket,
      Key:         key,
      Body:        params.buffer,
      ContentType: params.mimetype,
    },
  });

  await upload.done();
  return buildPublicUrl(key);
}

/**
 * Delete a file from S3 by its full key (path inside the bucket).
 * Pass the key extracted from the stored URL, not the full URL.
 */
export async function deleteFromS3(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key })
  );
}

/**
 * Extract the S3 key from a stored proxy public URL.
 * e.g. "http://localhost:5000/api/v1/storage/Leadryze_Bucket/tenantId/logos/file.png"
 *   → "Leadryze_Bucket/tenantId/logos/file.png"
 */
export function keyFromUrl(publicUrl: string): string {
  const prefix = `${resolveBaseUrl()}/api/${config.app.apiVersion}/storage/`;
  if (publicUrl.startsWith(prefix)) return publicUrl.slice(prefix.length);
  // Also strip a bare "/api/{version}/storage/" prefix regardless of host —
  // covers URLs stored before BACKEND_URL/RENDER_EXTERNAL_URL was available,
  // e.g. old rows saved with a localhost URL that no longer matches resolveBaseUrl().
  const pathPrefix = `/api/${config.app.apiVersion}/storage/`;
  const idx = publicUrl.indexOf(pathPrefix);
  return idx >= 0 ? publicUrl.slice(idx + pathPrefix.length) : publicUrl;
}
