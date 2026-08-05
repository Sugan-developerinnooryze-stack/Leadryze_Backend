import { z } from 'zod';
import { customFields, optionalObjectId } from '../../../utils/common.schemas';

export const createTeamSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  description: z.string().optional(),
  status:      z.enum(['active','inactive']).optional(),
  showInWidget: z.boolean().optional(),
  // .nullable() on top of optionalObjectId's own ''->undefined transform —
  // an explicit null is how the picker clears an already-set manager
  // (same convention already established for Tenant.widget.defaultTeamId).
  managerUserId: optionalObjectId.nullable(),
  serviceIds:  z.array(z.string().trim().min(1)).optional(),
  customFields,
});

export const updateTeamSchema = createTeamSchema.partial();
