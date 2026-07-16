import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createCallSchema = z.object({
  contactName: z.string().trim().min(1).max(200),
  direction:   z.enum(['inbound','outbound']).optional(),
  duration:    z.number().min(0).optional(),
  callStatus:  z.enum(['planned','completed','missed','cancelled']).optional(),
  date:        z.string().optional(),
  notes:       z.string().optional(),
  tags:        z.array(z.string()).optional(),
  customFields,
});

export const updateCallSchema = createCallSchema.partial();
