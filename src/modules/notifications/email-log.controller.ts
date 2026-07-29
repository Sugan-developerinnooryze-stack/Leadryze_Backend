import { Response } from 'express';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import * as svc from './email-log.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { channel, kind, status, from, to, page, limit } = req.query as Record<string, string | undefined>;
    const result = await svc.listLogs(
      req.tenantId!,
      { channel, kind, status, from, to },
      { page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined }
    );
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to fetch message history', 500);
  }
}
