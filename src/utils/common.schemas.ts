import { z } from 'zod';

export const idParam = z.object({
  id: z.string().min(1, 'ID is required'),
});

export const pageQuery = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  sort:   z.string().optional(),
  module: z.string().optional(),
});

export const customFields = z.record(z.unknown()).optional();

// LR-R2-ACT-001: a timezone name the runtime knows ("Asia/Singapore"), as the
// browser reports it. Confirmation and reminder e-mails format times in it,
// so anything else would break them.
export const ianaTimezone = z.string().trim().max(64).refine((tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, { message: 'timezone must be a timezone name such as Asia/Singapore' });

// For optional fields that map to a Mongoose ObjectId ref — an unselected
// dropdown sends "" rather than omitting the key, which Mongoose can't cast.
export const optionalObjectId = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const serviceLine = z.object({
  name:            z.string().trim().min(1),
  description:     z.string().optional(),
  amount:          z.number().min(0).optional(),
  count:           z.number().int().min(1).optional(),
  taxPercent:      z.number().min(0).max(100).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  durationHours:   z.number().min(0).optional(),
  serviceId:       z.string().optional(),
  frequency:       z.string().optional(),
});

export const partLine = z.object({
  name:        z.string().trim().min(1),
  description: z.string().optional(),
  partNumber:  z.string().optional(),
  amount:      z.number().min(0).optional(),
  count:       z.number().int().min(1).optional(),
});

