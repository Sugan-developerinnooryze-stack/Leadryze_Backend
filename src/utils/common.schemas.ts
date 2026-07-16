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

export const serviceLine = z.object({
  name:        z.string().trim().min(1),
  description: z.string().optional(),
  amount:      z.number().min(0).optional(),
  count:       z.number().int().min(1).optional(),
});

export const partLine = z.object({
  name:        z.string().trim().min(1),
  description: z.string().optional(),
  partNumber:  z.string().optional(),
  amount:      z.number().min(0).optional(),
  count:       z.number().int().min(1).optional(),
});

