import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createAssetSchema = z.object({
  name:           z.string().trim().min(1).max(200),
  category:       z.string().trim().optional(),
  serialNumber:   z.string().trim().optional(),
  purchaseDate:   z.string().optional(),
  warrantyExpiry: z.string().optional(),
  assignedTo:     z.string().trim().optional(),
  currentSite:    z.string().trim().optional(),
  condition:      z.enum(['new','good','fair','poor']).optional(),
  notes:          z.string().optional(),
  status:         z.enum(['active','in_use','under_maintenance','retired']).optional(),
  customFields,
});

export const updateAssetSchema = createAssetSchema.partial();
