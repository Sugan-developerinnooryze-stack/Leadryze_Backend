import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createActivitySchema = z.object({
  subject:       z.string().trim().min(1).max(300),
  type:          z.enum(['note','call','email','visit','task']).optional(),
  description:   z.string().optional(),
  relatedModule: z.string().trim().optional(),
  relatedId:     z.string().trim().optional(),
  scheduledAt:   z.string().optional(),
  completedAt:   z.string().optional(),
  assignedTo:    z.string().trim().optional(),
  status:        z.enum(['pending','completed','cancelled']).optional(),
  customFields,
});

export const updateActivitySchema = createActivitySchema.partial();
