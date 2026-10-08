import { z } from 'zod';

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['email', 'whatsapp', 'sms']),
  category: z.enum([
    'followup', 'booking', 'reminder', 'marketing', 'onboarding', 'feedback',
    'appointment', 'meeting', 'task', 'custom',
  ]),
  subject: z.string().trim().optional(),
  body: z.string().trim().min(1),
  language: z.string().trim().min(1).optional(),
});

export const updateTemplateSchema = createTemplateSchema.partial();

export const testSendTemplateSchema = z.object({
  to: z.string().trim().min(1),
});
