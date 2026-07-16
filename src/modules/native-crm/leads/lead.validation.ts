import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

const statusEnum   = z.enum(['new','contacted','qualified','meeting_scheduled','proposal_sent','negotiation','won','lost','on_hold','disqualified']);
const sourceEnum   = z.enum(['website','landing_page','chatbot','whatsapp','facebook','google','manual','csv','api','referral','other']);
const ratingEnum   = z.enum(['hot','warm','cold']);
const priorityEnum = z.enum(['high','medium','low']);

export const createLeadSchema = z.object({
  firstName:    z.string().trim().min(1).max(200),
  lastName:     z.string().trim().optional(),
  company:      z.string().trim().optional(),
  designation:  z.string().trim().optional(),
  industry:     z.string().trim().optional(),
  website:      z.string().trim().optional(),
  gstNumber:    z.string().trim().optional(),
  annualRevenue: z.number().optional(),
  employeeCount: z.number().int().optional(),

  email:          z.string().trim().email().optional().or(z.literal('')),
  secondaryEmail: z.string().trim().email().optional().or(z.literal('')),
  phone:          z.string().trim().optional(),
  mobile:         z.string().trim().optional(),
  whatsapp:       z.string().trim().optional(),
  alternatePhone: z.string().trim().optional(),
  linkedin:       z.string().trim().optional(),
  facebook:       z.string().trim().optional(),
  twitter:        z.string().trim().optional(),

  address:    z.string().trim().optional(),
  address2:   z.string().trim().optional(),
  city:       z.string().trim().optional(),
  state:      z.string().trim().optional(),
  country:    z.string().trim().optional(),
  postalCode: z.string().trim().optional(),

  status:   statusEnum.optional(),
  source:   sourceEnum.optional(),
  rating:   ratingEnum.optional(),
  score:    z.number().min(0).max(100).optional(),
  priority: priorityEnum.optional(),
  leadOwner: z.string().optional(),

  expectedRevenue:   z.number().optional(),
  expectedCloseDate: z.string().optional(),
  budget:            z.number().optional(),
  interestedProducts: z.array(z.string()).optional(),
  interestedServices: z.array(z.string()).optional(),
  competitor:        z.string().trim().optional(),
  requirement:       z.string().optional(),
  painPoints:        z.string().optional(),
  decisionMaker:     z.string().trim().optional(),
  purchaseTimeline:  z.string().trim().optional(),
  lostReason:        z.string().optional(),

  campaign:         z.string().trim().optional(),
  utmSource:        z.string().trim().optional(),
  utmMedium:        z.string().trim().optional(),
  utmCampaign:      z.string().trim().optional(),
  googleAdsId:      z.string().trim().optional(),
  facebookCampaign: z.string().trim().optional(),
  landingPage:      z.string().trim().optional(),

  tags:  z.array(z.string()).optional(),
  notes: z.string().optional(),
  customFields,
});

export const updateLeadSchema = createLeadSchema.partial();

export const updateStageSchema = z.object({
  status: statusEnum,
});
