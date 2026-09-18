import { S3Client, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { config } from '../config';
import { logger } from '../utils/logger';

// Real, confirmed bug this fixes: the AWS SDK v3's default NodeHttpHandler
// has connectionTimeout/requestTimeout/socketTimeout all set to 0 ("no
// timeout") unless explicitly configured. Supabase Storage's backing
// Postgres is already known to stall under load (see toStorageError()'s own
// comment on its "DatabaseTimeout" errors) — without a bound here, a single
// stalled upload's `await upload.done()` hangs forever with no error, no
// log line, nothing to catch. dataset-image.service.ts's processDatasetImages()
// runs this sequentially per row as the FIRST step of the import pipeline,
// so one hung image upload froze the entire dataset import at "importing"
// permanently — the exact bug behind datasets stuck at "Importing..." with
// zero further log activity. throwOnRequestTimeout is required alongside
// requestTimeout: without it, a breached requestTimeout only logs a warning
// and keeps waiting, it does not actually reject the call.
const s3RequestHandler = new NodeHttpHandler({
  connectionTimeout:    10_000,
  requestTimeout:       30_000,
  throwOnRequestTimeout: true,
  socketTimeout:        30_000,
});

export const s3Client = new S3Client({
  endpoint:        config.s3.endpoint,
  region:          config.s3.region,
  credentials: {
    accessKeyId:     config.s3.keyId,
    secretAccessKey: config.s3.secret,
  },
  forcePathStyle: true, // required for Supabase S3
  requestHandler: s3RequestHandler,
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

  try {
    await upload.done();
  } catch (err) {
    throw toStorageError(err, 'upload');
  }
  return buildPublicUrl(key);
}

/**
 * The S3 client talks to Supabase Storage, whose own errors (e.g. its
 * backing Postgres being unreachable — "DatabaseTimeout", HTTP 544) read as
 * if OUR database failed, which is misleading since this app's own MongoDB
 * is unrelated. Re-attribute any storage-layer failure to "file storage"
 * with a 502 (upstream dependency unavailable) so it's never confused with
 * a MongoDB outage, while still logging the real error for diagnostics.
 */
function toStorageError(err: unknown, action: 'upload' | 'delete'): Error & { statusCode: number } {
  logger.error(`S3-compatible storage ${action} failed`, { error: err instanceof Error ? err.message : err });
  const wrapped = new Error('Could not reach file storage — please try again in a moment.') as Error & { statusCode: number };
  wrapped.statusCode = 502;
  return wrapped;
}

/**
 * Delete a file from S3 by its full key (path inside the bucket).
 * Pass the key extracted from the stored URL, not the full URL.
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key })
    );
  } catch (err) {
    throw toStorageError(err, 'delete');
  }
}

/**
 * Deletes every object under an S3 key prefix — e.g. all of a dataset's
 * uploaded product images across every version at once, instead of the
 * caller having to reconstruct each individual {recordId}/{kind}.webp key
 * (fragile: depends on knowing the exact record count and which of the two
 * variants actually made it to storage). Real numbers this needs to handle:
 * a single import can be 500-800 products x 2 files (image + thumbnail)
 * each = up to ~1,600 objects — well past S3's 1,000-key-per-request cap on
 * BOTH list and delete, so both are paginated/chunked here rather than
 * assuming a single call covers everything. Best-effort: logs and returns
 * the count actually removed rather than throwing, since this runs as
 * cleanup after the "real" delete (the DB records) has already succeeded —
 * a storage hiccup here shouldn't make the whole delete action look failed
 * to the caller when the data itself is already gone.
 */
export async function deleteByPrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const listed = await s3Client.send(new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      const keys = (listed.Contents ?? []).map((obj) => obj.Key).filter((k): k is string => !!k);
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await s3Client.send(new DeleteObjectsCommand({
          Bucket: config.s3.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }));
        deleted += chunk.length;
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    logger.error('S3-compatible storage bulk delete-by-prefix failed', { prefix, deletedSoFar: deleted, error: err instanceof Error ? err.message : err });
  }
  return deleted;
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
