import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createProductSchema = z.object({
  name:         z.string().trim().min(1).max(200),
  sku:          z.string().trim().optional(),
  category:     z.string().trim().optional(),
  unit:         z.string().trim().optional(),
  costPrice:    z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  stock:        z.number().min(0).optional(),
  barcode:      z.string().trim().optional(),
  description:  z.string().optional(),
  status:       z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateProductSchema = createProductSchema.partial();
