import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createCompanySchema = z.object({
  name:          z.string().trim().min(1).max(200),
  domain:        z.string().trim().optional(),
  industry:      z.string().trim().optional(),
  employeeCount: z.number().int().min(0).optional(),
  phone:         z.string().trim().optional(),
  website:       z.string().trim().optional(),
  city:          z.string().trim().optional(),
  country:       z.string().trim().optional(),
  companyStatus: z.enum(['active','inactive','prospect']).optional(),
  notes:         z.string().optional(),
  tags:          z.array(z.string()).optional(),
  customFields,
});

export const updateCompanySchema = createCompanySchema.partial();
