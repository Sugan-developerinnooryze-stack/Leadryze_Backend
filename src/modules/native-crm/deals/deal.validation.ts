import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createDealSchema = z.object({
  title:       z.string().trim().min(1).max(200),
  // Tenant-configurable pipeline stage key — validity checked at the service
  // layer against this tenant's own stage list, not a fixed enum here.
  stage:       z.string().trim().min(1).optional(),
  amount:      z.number().min(0).optional(),
  currency:    z.string().trim().optional(),
  closeDate:   z.string().optional(),
  contactName: z.string().trim().optional(),
  companyName: z.string().trim().optional(),
  assignedStaffId: z.string().optional(),
  // LR-OPP-001: lets a Deal link to a real native-CRM Contact directly
  // (previously only ever set via Lead conversion) — accepts '' too, same
  // reasoning as Call/Task's own relatedId fields: that's how the picker
  // clears a previously-set link.
  contactId: z.string().optional(),
  // LR-OPP-001 (Company half): same reasoning as contactId above — lets a
  // Deal link to a real native-CRM Company directly.
  companyId: z.string().optional(),
  notes:       z.string().optional(),
  tags:        z.array(z.string()).optional(),
  customFields,
});

export const updateDealSchema = createDealSchema.partial();
