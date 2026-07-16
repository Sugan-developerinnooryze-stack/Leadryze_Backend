import { z } from 'zod';
import { customFields, serviceLine, partLine } from '../../../utils/common.schemas';

export const createWorkorderSchema = z.object({
  customerId:    z.string().trim().min(1),
  title:         z.string().trim().min(1).max(300),
  siteId:        z.string().trim().optional(),
  teamId:        z.string().trim().optional(),
  staffId:       z.string().trim().optional(),
  staffIds:      z.array(z.string().trim()).optional(),
  quotationId:   z.string().trim().optional(),
  contractId:    z.string().trim().optional(),
  contractVisitNumber: z.coerce.number().min(1).optional(),
  durationHours: z.coerce.number().min(0).max(24).optional(),
  scheduledDate: z.string().optional(),
  completedDate: z.string().optional(),
  services:      z.array(serviceLine).optional(),
  parts:         z.array(partLine).optional(),
  partsAmount:   z.number().min(0).optional(),
  priority:      z.enum(['low','medium','high']).optional(),
  status:        z.enum(['draft','scheduled','in_progress','completed','cancelled']).optional(),
  notes:         z.string().optional(),
  termsAndConditions: z.string().optional(),
  checklists:    z.array(z.object({ item: z.string(), completed: z.boolean().optional() })).optional(),
  customFields,
});

export const updateWorkorderSchema = createWorkorderSchema.partial();
