import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendError, sendCreated, sendPaginated } from '../../../utils/response';
import { captureLeadFromExternalSource, listLeadCaptures } from './lead-capture.service';

export async function create(req: AuthRequest, res: Response) {
  try {
    const { capture, lead } = await captureLeadFromExternalSource(
      req.tenantId!, req.branchId, req.user!.userId, req.user!.email, req.body,
    );
    sendCreated(res, { capture, lead }, lead ? 'Lead captured' : 'Capture recorded but no lead could be created');
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listLeadCaptures(req.tenantId!, req.query as any);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
