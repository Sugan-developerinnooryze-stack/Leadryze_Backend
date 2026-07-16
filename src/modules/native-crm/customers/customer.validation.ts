import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createCustomerSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  company:     z.string().trim().optional(),
  designation: z.string().trim().optional(),
  email:       z.string().trim().email().optional().or(z.literal('')),
  phone:       z.string().trim().optional(),
  mobile:      z.string().trim().optional(),
  website:     z.string().trim().optional(),
  address:     z.string().trim().optional(),
  city:     z.string().trim().optional(),
  state:    z.string().trim().optional(),
  postcode: z.string().trim().optional(),
  country:  z.string().trim().optional(),
  notes:    z.string().optional(),
  tags:     z.array(z.string()).optional(),
  status:   z.enum(['active','inactive']).optional(),
  customFields,
});

export const updateCustomerSchema = createCustomerSchema.partial();
