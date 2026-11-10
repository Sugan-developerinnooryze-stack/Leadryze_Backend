import { Router, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { resolveBranch } from '../../middlewares/branch.middleware';
import { requireModuleEnabled } from '../../middlewares/module-access.middleware';
import { dailyEventsRateLimit } from '../../middlewares/rate-limit.middleware';
import { resolveDataScopeMiddleware } from '../native-crm/shared/data-scope';
import { requireCrmAssistantFeature } from '../ai/crm-assistant-settings.service';
import { AuthRequest } from '../../types';
import { sendSuccess } from '../../utils/response';
import { getDailyEvents } from './daily-events.service';

/** The internal staff chat panel's "Daily Events" view (ChatWidget.tsx).
 * Same entry gates as the CRM assistant it lives in (bot.use + bot_enabled),
 * plus the tenant's own Daily Events switch (Settings → CRM Chatbot); every
 * module inside is then gated by its own flag and view permission, branch
 * and DataScope — exactly like that module's own screen. Read-only: tenant
 * and branch come only from the verified request, nothing is written,
 * nothing is sent, and no AI service is called. The only query parameter,
 * `fresh=1`, skips the short per-user cache. */
const router = Router();

router.use(authenticate, requireTenant, resolveBranch, resolveDataScopeMiddleware);

/** GET /api/v1/daily-events */
router.get(
  '/',
  requirePermission('bot.use'),
  requireModuleEnabled('bot_enabled'),
  requireCrmAssistantFeature('dailyEvents'),
  dailyEventsRateLimit,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const data = await getDailyEvents({
        tenantId: req.tenantId!,
        userId: req.user!.userId,
        branchId: req.branchId ?? null,
        role: req.user!.role,
        roleId: req.user!.roleId,
        featureFlags: req.featureFlags ?? {},
        dataScope: req.dataScope,
        dataScopeConfig: req.dataScopeConfig,
        dataScopeFailed: req.dataScopeFailed,
      }, { fresh: req.query.fresh === '1' });
      // Personal, time-sensitive data: never cached by a browser or proxy.
      res.set('Cache-Control', 'no-store');
      sendSuccess(res, data, 'Daily events');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
