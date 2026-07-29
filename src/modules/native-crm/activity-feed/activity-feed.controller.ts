import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import * as svc from './activity-feed.service';
import { RelatedModule } from './activity-feed.types';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { relatedModule, relatedId, page, limit } = req.query as unknown as {
      relatedModule: RelatedModule; relatedId: string; page: number; limit: number;
    };
    const result = await svc.getActivityFeed(req.tenantId!, relatedModule, relatedId, { page, limit });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch {
    sendError(res, 'Failed to fetch activity feed', 500);
  }
}
