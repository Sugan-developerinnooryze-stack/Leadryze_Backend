import { z } from 'zod';

export const listConversationsQuerySchema = z.object({
  page:  z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // 'waiting' | 'claimed' | 'mine' (claimed by the calling staff member) |
  // 'all' (every session that has ever had a handoff, any status).
  status: z.enum(['waiting', 'claimed', 'mine', 'all']).optional(),
});

export const sessionIdParam = z.object({
  sessionId: z.string().trim().min(1).max(200),
});

export const replyBodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const createLeadBodySchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName:  z.string().trim().max(100).optional(),
  email:     z.string().trim().email().max(200).optional(),
  phone:     z.string().trim().max(50).optional(),
});
