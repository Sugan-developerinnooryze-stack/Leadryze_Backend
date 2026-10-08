import { z } from 'zod';

export const shareEmailSchema = z.object({
  to:      z.string().trim().email(),
  cc:      z.array(z.string().trim().email()).optional(),
  subject: z.string().trim().min(1),
  message: z.string().optional(),
});

export const shareWhatsAppSchema = z.object({
  to:      z.string().trim().min(6),
  message: z.string().optional(),
});
