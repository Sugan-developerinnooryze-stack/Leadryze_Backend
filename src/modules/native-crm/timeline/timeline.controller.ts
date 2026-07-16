import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getTimeline } from './timeline.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.tenantId!;
    const { module, entityId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const items = await getTimeline(tenantId, module, entityId, limit);
    return sendSuccess(res, items);
  } catch (err: any) {
    return sendError(res, err.message);
  }
}
