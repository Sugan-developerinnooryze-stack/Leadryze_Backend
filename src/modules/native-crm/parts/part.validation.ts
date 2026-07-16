import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createPartSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  partNumber:  z.string().trim().optional(),
  description: z.string().trim().optional(),
  price:       z.number().min(0).optional(),
  unit:        z.string().trim().optional(),
  quantity:    z.number().min(0).optional(),
  status:      z.enum(['active','inactive']).optional(),
  customFields,
});

export const updatePartSchema = createPartSchema.partial();
