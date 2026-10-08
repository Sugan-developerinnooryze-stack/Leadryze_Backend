import { z } from 'zod';

const audienceSchema = z.object({
  type: z.enum(['all_customers', 'filtered', 'manual']).optional(),
  filter: z.record(z.unknown()).optional(),
  customerIds: z.array(z.string().trim().min(1)).optional(),
}).optional();

const scheduleSchema = z.object({
  startAt: z.string().trim().min(1).optional(),
  endAt: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
}).optional();

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['broadcast', 'drip', 'reengagement', 'followup']),
  channel: z.enum(['email', 'whatsapp', 'sms']), // 'instagram' deliberately excluded — no send implementation exists
  templateId: z.string().trim().min(1).optional(),
  audience: audienceSchema,
  schedule: scheduleSchema,
});

export const updateCampaignSchema = createCampaignSchema.partial();

export const testSendCampaignSchema = z.object({
  to: z.string().trim().min(1),
});
