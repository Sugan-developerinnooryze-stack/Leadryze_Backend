import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createCategorySchema = z.object({
  name:        z.string().trim().min(1).max(200),
  description: z.string().optional(),
  color:       z.string().trim().optional(),
  icon:        z.string().trim().optional(),
  status:      z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateCategorySchema = createCategorySchema.partial();
