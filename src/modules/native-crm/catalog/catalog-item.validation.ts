import { z } from 'zod';

export const createCatalogItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sku: z.string().trim().optional(),
  productCode: z.string().trim().optional(),
  category: z.string().trim().optional(),
  subCategory: z.string().trim().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  specifications: z.record(z.unknown()).optional(),
  attributes: z.record(z.unknown()).optional(),
  pdfs: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
  videos: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export const updateCatalogItemSchema = createCatalogItemSchema.partial();

export const importCatalogSchema = z.object({
  fileType: z.enum(['excel', 'csv', 'json']),
  fileLabel: z.string().trim().min(1),
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
});
