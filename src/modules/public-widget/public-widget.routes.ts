import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { widgetRateLimit } from '../../middlewares/rate-limit.middleware';
import { uploadAudio } from '../../middlewares/upload.middleware';
import * as ctrl from './public-widget.controller';
import {
  widgetConfigQuerySchema, widgetChatQuerySchema, widgetChatBodySchema, widgetVoiceChatBodySchema,
  widgetVoiceTokenBodySchema, widgetHistoryQuerySchema,
} from './public-widget.validation';

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
router.options(['/config', '/chat', '/voice/chat', '/voice/token'], ctrl.preflight);

router.get('/config', widgetRateLimit, validate({ query: widgetConfigQuerySchema }), ctrl.getConfig);
router.get('/history', widgetRateLimit, validate({ query: widgetHistoryQuerySchema }), ctrl.getHistory);
router.post('/chat', widgetRateLimit, validate({ query: widgetChatQuerySchema, body: widgetChatBodySchema }), ctrl.postChat);
// multer runs BEFORE validate() here — req.body only contains the text
// fields (sessionId/visitorId/pageUrl/durationSeconds) once multer has
// parsed the multipart request; the audio itself lands on req.file.
router.post(
  '/voice/chat', widgetRateLimit, uploadAudio.single('audio'),
  validate({ query: widgetChatQuerySchema, body: widgetVoiceChatBodySchema }), ctrl.postVoiceChat,
);
// Continuous, hands-free voice mode — mints a LiveKit room token instead of
// proxying a single request/response turn (see public-widget.controller.ts).
router.post(
  '/voice/token', widgetRateLimit,
  validate({ query: widgetChatQuerySchema, body: widgetVoiceTokenBodySchema }), ctrl.getVoiceToken,
);

export default router;
