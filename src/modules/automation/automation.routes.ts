import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { AutomationRun } from './automation-run.model';

const router = Router();
router.use(authenticate, requireTenant);

// GET /api/v1/automation-runs?page=1&limit=20&status=
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = new mongoose.Types.ObjectId(req.user!.tenantId);
    const page     = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit    = Math.min(50, parseInt(req.query.limit as string) || 20);
    const status   = req.query.status as string | undefined;

    const filter: Record<string, unknown> = { tenantId };
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      AutomationRun.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AutomationRun.countDocuments(filter),
    ]);

    // Stats counts
    const [totalCount, completedCount, partialCount, failedCount, runningCount] = await Promise.all([
      AutomationRun.countDocuments({ tenantId }),
      AutomationRun.countDocuments({ tenantId, status: 'completed' }),
      AutomationRun.countDocuments({ tenantId, status: 'partial' }),
      AutomationRun.countDocuments({ tenantId, status: 'failed' }),
      AutomationRun.countDocuments({ tenantId, status: 'running' }),
    ]);

    sendSuccess(res, {
      items,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: { total: totalCount, completed: completedCount, partial: partialCount, failed: failedCount, running: runningCount },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/automation-runs/:id
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = new mongoose.Types.ObjectId(req.user!.tenantId);
    const run = await AutomationRun.findOne({ _id: req.params.id, tenantId }).lean();
    if (!run) return sendError(res, 'Not found', 404);
    sendSuccess(res, run);
  } catch (err) { next(err); }
});

// DELETE /api/v1/automation-runs/:id
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = new mongoose.Types.ObjectId(req.user!.tenantId);
    const result = await AutomationRun.deleteOne({ _id: req.params.id, tenantId });
    if (result.deletedCount === 0) return sendError(res, 'Not found', 404);
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
});

export default router;
