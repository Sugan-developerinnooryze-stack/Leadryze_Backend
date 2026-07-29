import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createTicketSchema = z.object({
  subject:      z.string().trim().min(1).max(300),
  priority:     z.enum(['low','medium','high','critical']).optional(),
  // Tenant-configurable pipeline stage key — validity checked at the service
  // layer against this tenant's own stage list, not a fixed enum here.
  ticketStatus: z.string().trim().min(1).optional(),
  description:  z.string().optional(),
  contactName:  z.string().trim().optional(),
  tags:         z.array(z.string()).optional(),
  // Plain optional strings (not optionalObjectId's empty->undefined transform:
  // relatedId is a trimmed String path, not a Mongoose ObjectId ref, and this
  // trio must accept '' as a real, savable value — that's how the frontend
  // clears a previously-set link via $set; transforming '' to undefined would
  // make Mongoose silently drop it from $set, leaving the stale link in place.
  relatedModule: z.union([z.enum(['contact','company','deal','customer','quotation','workorder','contract']), z.literal('')]).optional(),
  relatedId:     z.string().trim().optional(),
  relatedLabel:  z.string().trim().optional(),
  customFields,
});

export const updateTicketSchema = createTicketSchema.partial();
