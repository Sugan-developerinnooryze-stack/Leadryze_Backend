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

export const updateCallSchema = createCallSchema.partial();
