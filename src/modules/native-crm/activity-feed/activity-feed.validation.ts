import { z } from 'zod';

export const activityFeedQuerySchema = z.object({
  relatedModule: z.enum(['contact', 'company', 'deal', 'customer', 'quotation', 'workorder', 'contract']),
  relatedId:     z.string().trim().min(1),
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
