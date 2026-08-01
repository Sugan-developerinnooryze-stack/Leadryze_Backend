import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { widgetRateLimit } from '../../middlewares/rate-limit.middleware';
import * as ctrl from './public-widget.controller';
import { widgetConfigQuerySchema, widgetChatQuerySchema, widgetChatBodySchema } from './public-widget.validation';

/** Public, unauthenticated — the website widget's entry point. Deliberately
 * NOT behind /native-crm's authenticate/requireTenant, and deliberately NOT
 * covered by the app-wide fixed-allowlist cors() call in app.ts — this
 * module hand-rolls its own dynamic, per-tenant CORS (see
 * public-widget.controller.ts's own comments for why), since the tenant
 * this request belongs to isn't known until AFTER resolving `widgetKey`,
 * which the fixed global allowlist has no way to do. */
const router = Router();

// widgetKey/tenant resolved fresh here too (see preflight()'s own comment).
// No rate limit on OPTIONS itself — browsers issue these automatically and
// they do no real work (no DB write, no AI call).
router.options(['/config', '/chat'], ctrl.preflight);

router.get('/config', widgetRateLimit, validate({ query: widgetConfigQuerySchema }), ctrl.getConfig);
router.post('/chat', widgetRateLimit, validate({ query: widgetChatQuerySchema, body: widgetChatBodySchema }), ctrl.postChat);

export default router;
