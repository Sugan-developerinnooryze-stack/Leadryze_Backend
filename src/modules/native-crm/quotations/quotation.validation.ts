import { z } from 'zod';
import { customFields, serviceLine, partLine } from '../../../utils/common.schemas';

export const createQuotationSchema = z.object({
  customerId:            z.string().trim().min(1),
  title:                 z.string().trim().min(1).max(300),
  address:               z.string().trim().optional(),
  services:              z.array(serviceLine).optional(),
  parts:                 z.array(partLine).optional(),
  partsAmount:           z.number().min(0).optional(),
  discount:              z.number().min(0).optional(),
  gstPercentage:         z.number().min(0).optional(),
  servicesAmount:        z.number().min(0).optional(),
  servicesAmountWithTax: z.number().min(0).optional(),
  // Tenant-configurable pipeline stage key — validity checked at the service
  // layer against this tenant's own stage list, not a fixed enum here.
  status:                z.string().trim().min(1).optional(),
  notes:                 z.string().optional(),
  termsAndConditions:    z.string().optional(),
  validUntil:            z.string().optional(),
  customFields,
});

export const updateQuotationSchema = createQuotationSchema.partial();
