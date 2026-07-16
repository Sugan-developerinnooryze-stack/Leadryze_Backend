import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createStaffSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName:  z.string().trim().min(1).max(100),
  email:     z.string().trim().email().optional().or(z.literal('')),
  phone:     z.string().trim().optional(),
  teamId:    z.string().trim().optional(),
  role:      z.string().trim().optional(),
  status:    z.enum(['active','inactive','onleave']).optional(),
  customFields,
});

export const updateStaffSchema = createStaffSchema.partial();
