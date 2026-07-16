import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createServiceSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  description: z.string().trim().optional(),
  categoryId:  z.string().trim().optional(),
  price:       z.coerce.number().min(0).optional(),
  unit:        z.string().trim().optional(),
  duration:    z.coerce.number().min(0).optional(),
  status:      z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateServiceSchema = createServiceSchema.partial();
