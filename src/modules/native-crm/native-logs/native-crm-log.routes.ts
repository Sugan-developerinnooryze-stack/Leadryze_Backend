import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { NativeCrmLog } from '../../logs/native-crm-log.model';

const router = Router();

/**
 * GET /api/v1/native-crm/native-logs
 * Returns paginated native CRM activity logs for the current tenant.
 * Query: page, limit, module, action, startDate, endDate, search (actor name)
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.tenantId) { sendError(res, 'Unauthorized', 401); return; }

    const { module, action, startDate, endDate, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  as string || '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string || '20', 10)));
    const skip  = (page - 1) * limit;

    const filter: Record<string, unknown> = { tenantId: req.tenantId };

    if (module && typeof module === 'string')  filter.module = module;
    if (action && typeof action === 'string')  filter.action = action;
    if (search && typeof search === 'string') {
      filter.actorName = { $regex: search, $options: 'i' };
    }
    if (startDate || endDate) {
      const range: Record<string, Date> = {};
      if (startDate) range.$gte = new Date(startDate as string);
      if (endDate)   range.$lte = new Date(endDate as string);
      filter.timestamp = range;
    }

    const [items, total] = await Promise.all([
      NativeCrmLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      NativeCrmLog.countDocuments(filter),
    ]);

    sendSuccess(res, {
      items,
      meta: {
        total,
        page,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
});

export default router;
