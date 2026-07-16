import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createDealSchema = z.object({
  title:       z.string().trim().min(1).max(200),
  stage:       z.enum(['prospect','qualified','proposal','negotiation','closed_won','closed_lost']).optional(),
  amount:      z.number().min(0).optional(),
  currency:    z.string().trim().optional(),
  closeDate:   z.string().optional(),
  contactName: z.string().trim().optional(),
  companyName: z.string().trim().optional(),
  notes:       z.string().optional(),
  tags:        z.array(z.string()).optional(),
  customFields,
});

export const updateDealSchema = createDealSchema.partial();
