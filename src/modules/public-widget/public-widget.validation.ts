import { z } from 'zod';

/** wgt_ + 32 hex chars — matches tenant.service.ts's regenerateWidgetKey()
 * generation exactly (crypto.randomBytes(16).toString('hex')). */
const widgetKeySchema = z.string().trim().regex(/^wgt_[a-f0-9]{32}$/);

export const widgetConfigQuerySchema = z.object({
  widgetKey: widgetKeySchema,
});

export const widgetChatQuerySchema = z.object({
  widgetKey: widgetKeySchema,
});

export const widgetChatBodySchema = z.object({
  sessionId:  z.string().trim().min(1).max(200),
  visitorId:  z.string().trim().min(1).max(200).optional(),
  message:    z.string().trim().min(1).max(4000),
  pageUrl:    z.string().trim().max(2000).optional(),
});

// Text fields only — the audio itself is a multipart file field, handled by
// multer before this schema ever runs (req.body is only populated with the
// text fields by the time validate() checks it).
export const widgetVoiceChatBodySchema = z.object({
  sessionId:       z.string().trim().min(1).max(200),
  visitorId:       z.string().trim().min(1).max(200).optional(),
  pageUrl:         z.string().trim().max(2000).optional(),
  durationSeconds: z.coerce.number().min(0).max(120).optional(),
});

export const widgetVoiceTokenBodySchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  visitorId: z.string().trim().min(1).max(200).optional(),
});

// GET /public/widget/history?widgetKey=...&sessionId=...&visitorId=...
// visitorId is REQUIRED here (unlike chat/voice-token) — it's the second
// ownership factor alongside sessionId that makes this read-only history
// endpoint safe to expose without any other auth. `limit` is optionally
// client-supplied but always re-clamped server-side to a hard 200 cap
// regardless of what's requested (see the controller). `before` is an ISO
// timestamp cursor (a message's own `timestamp` field).
export const widgetHistoryQuerySchema = z.object({
  widgetKey: widgetKeySchema,
  sessionId: z.string().trim().min(1).max(200),
  visitorId: z.string().trim().min(1).max(200),
  limit:     z.coerce.number().int().min(1).max(200).optional(),
  before:    z.string().trim().datetime({ offset: true }).optional(),
});
