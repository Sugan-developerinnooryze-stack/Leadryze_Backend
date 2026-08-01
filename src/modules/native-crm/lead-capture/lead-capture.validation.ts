import { z } from 'zod';

export const platformSchema = z.enum(['linkedin', 'apollo', 'website', 'chatbot', 'other']);

/** `raw` is deliberately only required to be AN OBJECT, not a non-empty one
 * or one with any particular key. A Zod rejection happens before the
 * request ever reaches the service layer, which means NO LeadCapture audit
 * doc would get written for it — defeating the point of auditing malformed
 * captures too. The "no usable name in raw" business rule is handled in
 * lead-capture.service.ts instead, where a status:'failed' doc can still be
 * written before stopping. `platform`/`sourceUrl` ARE hard-required here —
 * they're structural metadata the extension always knows about the tab
 * itself, not scraped page content. */
export const createLeadCaptureSchema = z.object({
  platform:  platformSchema,
  sourceUrl: z.string().trim().min(1).max(2000).url(),
  raw:       z.record(z.unknown()),
  extensionVersion: z.string().trim().max(50).optional(),
});

export const listLeadCaptureQuerySchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  platform:         platformSchema.optional(),
  status:           z.enum(['pending', 'created', 'failed']).optional(),
  capturedByUserId: z.string().optional(),
  startDate:        z.string().optional(),
  endDate:          z.string().optional(),
});
