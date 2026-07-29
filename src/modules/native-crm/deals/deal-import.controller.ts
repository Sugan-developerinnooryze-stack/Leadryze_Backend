import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { importDealsCsv } from './deal-import.service';

export async function importCsv(req: AuthRequest, res: Response) {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return sendError(res, 'rows must be a non-empty array', 400);
    }
    const summary = await importDealsCsv(req.tenantId!, rows, req.user?.userId);
    sendSuccess(res, summary);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
