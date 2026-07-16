import { Router, Request, Response, NextFunction } from 'express';
import { getTenantLogs } from './log.service';
import { sendSuccess, sendError } from '../../utils/response';
import { authenticate } from '../../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);

/**
 * GET /api/v1/logs
 * Returns paginated activity logs for the current tenant.
 * Query: service=ai|backend, level=info|warn|error, from, to, limit, offset
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as Request & { user?: { tenantId?: string } }).user?.tenantId;
    if (!tenantId) { sendError(res, 'Unauthorized', 401); return; }

    const { service, level, from, to, limit, offset } = req.query;

    const result = await getTenantLogs({
      tenantId,
      service: service as 'ai' | 'backend' | undefined,
      level:   level as string | undefined,
      from:    from ? new Date(from as string) : undefined,
      to:      to   ? new Date(to   as string) : undefined,
      limit:   limit  ? parseInt(limit  as string, 10) : 50,
      offset:  offset ? parseInt(offset as string, 10) : 0,
    });

    sendSuccess(res, result, 'Logs fetched');
  } catch (err) {
    next(err);
  }
});

export default router;
