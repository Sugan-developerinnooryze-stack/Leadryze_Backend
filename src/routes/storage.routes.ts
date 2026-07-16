import { Router, Request, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../services/s3.service';
import { config } from '../config';

const router = Router();

/**
 * GET /api/v1/storage/* — public proxy for S3 files.
 * The S3 object key is the full URL path after /storage/.
 * e.g. /storage/tenantId/logos/timestamp-file.jpg
 *      → streams Bucket/tenantId/logos/timestamp-file.jpg from S3.
 *
 * No auth required — the key itself is unpredictable (tenantId + timestamp).
 */
router.get('/*', async (req: Request, res: Response) => {
  const key = (req.params as any)[0] as string;
  if (!key) { res.status(400).json({ error: 'Missing file key' }); return; }

  try {
    const command = new GetObjectCommand({ Bucket: config.s3.bucket, Key: key });
    const s3Res   = await s3Client.send(command);

    if (!s3Res.Body) { res.status(404).json({ error: 'File not found' }); return; }

    // Forward content headers
    if (s3Res.ContentType)   res.setHeader('Content-Type',   s3Res.ContentType);
    if (s3Res.ContentLength) res.setHeader('Content-Length', s3Res.ContentLength);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year

    // Stream S3 body to browser
    const stream = s3Res.Body as NodeJS.ReadableStream;
    stream.pipe(res);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  } catch (err: any) {
    const status = err?.name === 'NoSuchKey' ? 404 : 500;
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
});

export default router;
