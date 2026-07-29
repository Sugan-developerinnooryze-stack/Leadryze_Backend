import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { importLeadsCsv, listTriageItems, resolveTriageItem } from './lead-import.service';

export async function importCsv(req: AuthRequest, res: Response) {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return sendError(res, 'rows must be a non-empty array', 400);
    }
    const summary = await importLeadsCsv(req.tenantId!, rows, req.user?.userId);
    sendSuccess(res, summary);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function listTriage(req: AuthRequest, res: Response) {
  try {
    const items = await listTriageItems(req.tenantId!, req.query.batchId as string | undefined);
    sendSuccess(res, items);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function resolveTriage(req: AuthRequest, res: Response) {
  try {
    const { action } = req.body;
    if (action !== 'create' && action !== 'skip') {
      return sendError(res, "action must be 'create' or 'skip'", 400);
    }
    const item = await resolveTriageItem(req.tenantId!, req.params.id, action, req.user?.userId);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
