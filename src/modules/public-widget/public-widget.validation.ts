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

// POST /public/widget/handoff/request — visitor clicks "Connect with an
// expert." pageUrl travels in the body here (unlike history's query string)
// since this is a POST, matching widgetChatBodySchema's own pageUrl shape.
export const widgetHandoffRequestBodySchema = z.object({
  sessionId:    z.string().trim().min(1).max(200),
  visitorId:    z.string().trim().min(1).max(200).optional(),
  visitorName:  z.string().trim().min(1).max(200).optional(),
  visitorEmail: z.string().trim().email().max(200).optional(),
  visitorPhone: z.string().trim().min(1).max(50).optional(),
  pageUrl:      z.string().trim().max(2000).optional(),
});

// GET /public/widget/handoff/history?widgetKey=...&sessionId=...&visitorId=...
// visitorId required, same ownership-factor reasoning as widgetHistoryQuerySchema.
export const widgetHandoffHistoryQuerySchema = z.object({
  widgetKey: widgetKeySchema,
  sessionId: z.string().trim().min(1).max(200),
  visitorId: z.string().trim().min(1).max(200),
});

// POST /public/widget/connect-branch/submit — the "Connect with Your Local
// Branch" lead-capture form, a SEPARATE feature from Human Handoff above.
// `values` is a generic field-key -> string map, deliberately not a fixed
// shape: the actual field LIST is tenant-configurable
// (Tenant.widget.connectBranch.fields), so this schema only bounds payload
// size/shape (defense against abuse) — the real per-field required/type
// validation happens server-side in the controller against the tenant's own
// saved field config, never trusting field definitions from the client.
// No `branchId` here — the visitor types City/State (plain text, matching
// the reference design), and the controller best-effort matches a Branch
// from those values server-side rather than the visitor picking one.
export const widgetConnectBranchSubmitBodySchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  visitorId: z.string().trim().min(1).max(200).optional(),
  pageUrl:   z.string().trim().max(2000).optional(),
  values:    z.record(z.string().max(60), z.string().trim().max(2000)).refine(
    (v) => Object.keys(v).length <= 30,
    { message: 'Too many fields' },
  ),
});
