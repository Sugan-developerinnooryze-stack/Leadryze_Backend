import { z } from 'zod';

const slaPriorityPolicySchema = z.object({
  priority:              z.enum(['low', 'medium', 'high', 'critical']),
  firstResponseMinutes:  z.number().int().min(1),
  resolutionMinutes:     z.number().int().min(1),
});

export const updateSlaPolicySchema = z.object({
  enabled:        z.boolean().optional(),
  warningPercent: z.number().int().min(1).max(99).optional(),
  policies:       z.array(slaPriorityPolicySchema).min(1).optional(),
});
