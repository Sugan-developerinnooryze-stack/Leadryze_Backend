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
