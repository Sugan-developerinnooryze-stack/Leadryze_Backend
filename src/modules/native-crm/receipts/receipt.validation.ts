import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createReceiptSchema = z.object({
  invoiceId:     z.string().trim().min(1),
  customerId:    z.string().trim().min(1),
  // LR-R26-RCPT-006: a new receipt of 0 is refused here as a field error
  // (shown under Amount), before the service runs. min(0) let 0 through.
  amount:        z.number().positive('Receipt amount must be greater than 0'),
  paymentMethod: z.enum(['cash','bank_transfer','card','cheque','online']).optional(),
  paymentDate:   z.string().optional(),
  notes:         z.string().optional(),
  status:        z.enum(['pending','completed','refunded']).optional(),
  customFields,
  // LR-C4-RCPT-005: kept so it reaches the service (an unknown field is
  // dropped here, so the key never arrived and payments were merged).
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

// Update keeps the old rule (0 allowed through to the service, which already
// refuses 0 unless the receipt is refunded), so editing is unchanged.
export const updateReceiptSchema = createReceiptSchema.omit({ idempotencyKey: true }).extend({ amount: z.number().min(0) }).partial();
