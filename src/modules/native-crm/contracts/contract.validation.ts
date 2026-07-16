import { z } from 'zod';
import { customFields, partLine } from '../../../utils/common.schemas';

/** Rule-based schedule for one contract service line. */
const scheduleRule = z.object({
  frequency: z.enum([
    'once', 'daily', 'weekly', 'fortnightly', 'monthly', 'bimonthly',
    'quarterly', 'halfyearly', 'yearly', 'custom_interval', 'custom_dates',
  ]),
  weekdays:   z.array(z.coerce.number().min(0).max(6)).optional(),
  dayOfMonth: z.union([z.coerce.number().min(1).max(31), z.literal('last')]).optional(),
  months:     z.array(z.coerce.number().min(1).max(12)).optional(),
  everyNDays: z.coerce.number().min(1).optional(),
  dates:      z.array(z.string()).optional(),
});

/** Contract service line — base line + its own schedule rule and pricing. */
const contractServiceLine = z.object({
  name:            z.string().trim().min(1),
  description:     z.string().optional(),
  amount:          z.coerce.number().min(0).default(0),
  count:           z.coerce.number().min(1).default(1),
  scheduleRule:    scheduleRule.optional(),
  durationHours:   z.coerce.number().min(0).optional(),
  taxPercent:      z.coerce.number().min(0).optional(),
  discountPercent: z.coerce.number().min(0).optional(),
  requiredSkill:   z.string().trim().optional(),
  serviceId:       z.string().trim().optional(),
});

export const createContractSchema = z.object({
  branchId:              z.string().nullable().optional(),
  customerId:            z.string().trim().min(1),
  title:                 z.string().trim().min(1).max(300),
  quotationId:           z.string().trim().optional(),
  startDate:             z.string().optional(),
  endDate:               z.string().optional(),
  noEndDate:             z.boolean().optional(),
  services:              z.array(contractServiceLine).optional(),
  parts:                 z.array(partLine).optional(),
  partsAmount:           z.number().min(0).optional(),
  serviceFrequency:      z.string().trim().optional(),
  // Master-engine fields
  contractType:          z.enum(['amc','maintenance','rental','warranty','preventive','corrective','installation','inspection','custom']).optional(),
  priority:              z.enum(['low','medium','high','critical']).optional(),
  siteId:                z.string().trim().optional(),
  teamId:                z.string().trim().optional(),
  staffId:               z.string().trim().optional(),
  staffIds:              z.array(z.string().trim()).optional(),
  renewalType:           z.enum(['manual','automatic']).optional(),
  renewBeforeDays:       z.coerce.number().min(0).optional(),
  woGenerationMode:      z.enum(['manual','on_visit_day','days_before']).optional(),
  woLeadDays:            z.coerce.number().min(0).optional(),
  // Legacy recurrence (was silently stripped before — now whitelisted)
  recurringUnit:         z.enum(['day','week','fortnight','month','bimonthly','quarter','halfyear','year','custom']).optional(),
  recurringInterval:     z.coerce.number().min(1).optional(),
  nextServiceDate:       z.string().optional(),
  discount:              z.number().min(0).optional(),
  gstPercentage:         z.number().min(0).optional(),
  servicesAmount:        z.number().min(0).optional(),
  servicesAmountWithTax: z.number().min(0).optional(),
  status:                z.enum(['draft','pending','active','suspended','completed','expired','cancelled']).optional(),
  notes:                 z.string().optional(),
  termsAndConditions:    z.string().optional(),
  customFields,
});

export const updateContractSchema = createContractSchema.partial();
