import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createTeamSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  description: z.string().optional(),
  status:      z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateTeamSchema = createTeamSchema.partial();
