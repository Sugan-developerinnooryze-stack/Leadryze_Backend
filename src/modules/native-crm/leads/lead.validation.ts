import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

// Stage keys are tenant-configurable (native-crm/pipeline-config), so this is
// no longer a fixed enum — validity against the tenant's own stage list is
// checked at the service layer instead.
const statusSchema = z.string().trim().min(1);
// LR-LEAD-003: a phone field accepted letters ("abc123") outright — digits,
// spaces, and the usual +/-/() punctuation only. .or(literal('')) mirrors
// email's own optional-but-not-""-isn't-a-format-error pattern below.
// Exported as a plain regex (not just the zod schema) so other server-side
// validators that aren't themselves zod-object fields (e.g. the Connect-
// with-Branch form's per-field type check) can reuse the identical rule
// instead of redefining it.
export const PHONE_FORMAT_REGEX = /^[0-9+\-\s()]+$/;
const phoneSchema = z.string().trim().regex(PHONE_FORMAT_REGEX, 'Enter a valid phone number').optional().or(z.literal(''));
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

  email:          z.string().trim().email('Invalid email address').optional().or(z.literal('')),
  secondaryEmail: z.string().trim().email('Invalid email address').optional().or(z.literal('')),
  phone:          phoneSchema,
  mobile:         phoneSchema,
  whatsapp:       phoneSchema,
  alternatePhone: phoneSchema,
  linkedin:       z.string().trim().optional(),
  facebook:       z.string().trim().optional(),
  twitter:        z.string().trim().optional(),

  address:    z.string().trim().optional(),
  address2:   z.string().trim().optional(),
  city:       z.string().trim().optional(),
  state:      z.string().trim().optional(),
  country:    z.string().trim().optional(),
  postalCode: z.string().trim().optional(),

  status:   statusSchema.optional(),
  source:   sourceEnum.optional(),
  rating:   ratingEnum.optional(),
  score:    z.number().min(0).max(100).optional(),
  priority: priorityEnum.optional(),
  leadOwner: z.string().optional(),
  leadOwnerStaffId: z.string().optional(),

  // LR-LEAD-004: unbounded negative/absurd values here corrupted Pipeline
  // Value aggregates — min(0) plus a generous sanity ceiling (anything
  expectedRevenue:   z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
    z.number({ invalid_type_error: 'Expected Revenue must be a number' })
      .min(0, 'Expected Revenue must be ≥ 0')
      .max(1_000_000_000_000, 'Expected Revenue cannot exceed 1,000,000,000,000')
      .optional()
  ),
  budget:            z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
    z.number({ invalid_type_error: 'Budget must be a number' })
      .min(0, 'Budget must be ≥ 0')
      .max(1_000_000_000_000, 'Budget cannot exceed 1,000,000,000,000')
      .optional()
  ),
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

// LR-NEG-001: same reasoning as contact.validation.ts's updateContactSchema
// — getLeadById's stale-save check needs updatedAt/__v on the wire, or
// validate.middleware.ts strips them before the service ever sees them.
export const updateLeadSchema = createLeadSchema.partial().extend({
  updatedAt: z.string().optional(),
  __v: z.number().optional(),
});

export const updateStageSchema = z.object({
  status: statusSchema,
});
