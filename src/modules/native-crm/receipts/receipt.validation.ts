import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createReceiptSchema = z.object({
  invoiceId:     z.string().trim().min(1),
  customerId:    z.string().trim().min(1),
  amount:        z.number().min(0),
  paymentMethod: z.enum(['cash','bank_transfer','card','cheque','online']).optional(),
  paymentDate:   z.string().optional(),
  notes:         z.string().optional(),
  status:        z.enum(['pending','completed','refunded']).optional(),
  customFields,
});

export const updateReceiptSchema = createReceiptSchema.partial();
