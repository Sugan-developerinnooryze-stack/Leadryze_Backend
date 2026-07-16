import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createTaskSchema = z.object({
  title:      z.string().trim().min(1).max(300),
  dueDate:    z.string().optional(),
  priority:   z.enum(['low','medium','high']).optional(),
  taskStatus: z.enum(['todo','in_progress','done','cancelled']).optional(),
  assignedTo: z.string().trim().optional(),
  notes:      z.string().optional(),
  tags:       z.array(z.string()).optional(),
  customFields,
});

export const updateTaskSchema = createTaskSchema.partial();
