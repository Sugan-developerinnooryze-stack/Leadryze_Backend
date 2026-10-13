import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

const lifecycleStage = z.enum(['subscriber','lead','marketing_qualified_lead','sales_qualified_lead','opportunity','customer','evangelist','other']).optional();
const leadStatus     = z.enum(['new','open','in_progress','open_deal','unqualified','attempted_to_contact','connected','bad_timing']).optional();

export const createContactSchema = z.object({
  firstName:      z.string().trim().min(1).max(100),
  lastName:       z.string().trim().min(1).max(100),
  email:          z.string().trim().email(),
  phone:          z.string().trim().optional(),
  company:        z.string().trim().optional(),
  companyId:      z.string().trim().optional(),
  jobTitle:       z.string().trim().optional(),
  contactOwner:   z.string().trim().optional(),
  lifecycleStage,
  leadStatus,
  status:         z.enum(['lead','contact','customer']).optional(),
  source:         z.enum(['website','referral','social','email','cold','other']).optional(),
  notes:          z.string().optional(),
  tags:           z.array(z.string()).optional(),
  customFields,
});

// LR-NEG-001: stale-save/conflict detection (contact.service.ts's
// updateContact) reads dto.updatedAt/dto.__v — without declaring them here,
// validate.middleware.ts's req.body = schema.parse(req.body) silently
// strips both before the service function ever runs, making the whole
// version check unreachable over the real API (confirmed live: a prior
// "fix" claimed this worked, but only because whatever verified it called
// the service function directly, bypassing this exact stripping).
export const updateContactSchema = createContactSchema.partial().extend({
  updatedAt: z.string().optional(),
  __v: z.number().optional(),
});
