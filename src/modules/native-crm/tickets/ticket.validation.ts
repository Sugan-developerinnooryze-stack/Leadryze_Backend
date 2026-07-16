import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createTicketSchema = z.object({
  subject:      z.string().trim().min(1).max(300),
  priority:     z.enum(['low','medium','high','critical']).optional(),
  ticketStatus: z.enum(['open','in_progress','resolved','closed']).optional(),
  description:  z.string().optional(),
  contactName:  z.string().trim().optional(),
  tags:         z.array(z.string()).optional(),
  customFields,
});

export const updateTicketSchema = createTicketSchema.partial();
