import { z } from 'zod';
import { customFields, optionalObjectId } from '../../../utils/common.schemas';

export const createSiteSchema = z.object({
  name:          z.string().trim().min(1).max(200),
  address:       z.string().trim().min(1),
  city:          z.string().trim().optional(),
  state:         z.string().trim().optional(),
  postcode:      z.string().trim().optional(),
  country:       z.string().trim().optional(),
  customerId:    optionalObjectId,
  contactPerson: z.string().trim().optional(),
  phone:         z.string().trim().optional(),
  notes:         z.string().optional(),
  status:        z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateSiteSchema = createSiteSchema.partial();
