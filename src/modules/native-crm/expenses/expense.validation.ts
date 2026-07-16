import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createExpenseSchema = z.object({
  title:       z.string().trim().min(1).max(300),
  amount:      z.number().min(0),
  category:    z.string().trim().optional(),
  date:        z.string().optional(),
  paidBy:      z.string().trim().optional(),
  workOrderId: z.string().trim().optional(),
  notes:       z.string().optional(),
  status:      z.enum(['pending','approved','rejected']).optional(),
  customFields,
});

export const updateExpenseSchema = createExpenseSchema.partial();
