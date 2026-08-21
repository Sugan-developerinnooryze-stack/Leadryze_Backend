import { z } from 'zod';

const columnSchema = z.object({
  originalName: z.string().min(1),
  normalizedName: z.string().min(1),
  // Real, confirmed bug this closes: dataset-schema.service.ts's own
  // ROLE_PATTERNS already detects 'image' (and dataset-version.model.ts's
  // SemanticRole type already includes it), but this enum was never updated
  // to match — a tenant whose Excel already has real, hosted image URLs had
  // that column's role silently rejected by validation the moment they
  // confirmed the import, even though search-dataset.tool.ts's card-
  // building already knows how to read and render an image-role column.
  semanticRole: z.enum(['name', 'category', 'price', 'location', 'date', 'description', 'identifier', 'image']).optional(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['heuristic', 'manual']),
  dataType: z.enum(['string', 'number', 'currency', 'date', 'boolean']),
});

// Capped at a real ceiling — a preview sample never needs more than a
// handful of rows to analyze; the caller (frontend) sends a small slice,
// not the whole file, for this endpoint specifically.
export const analyzeDatasetSchema = z.object({
  headers: z.array(z.string()).min(1).max(200),
  sampleRows: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
});

export const startImportSchema = z.object({
  datasetId: z.string().trim().optional(),
  name: z.string().trim().min(1).max(200),
  sourceFileName: z.string().trim().min(1),
  sourceType: z.enum(['excel', 'csv', 'json']),
  columns: z.array(columnSchema).min(1).max(200),
  headerRowIndex: z.number().int().min(0),
  // A generous but real ceiling — protects the ingestion pipeline (and the
  // AI service's batch-embedding calls) from an unbounded request; a
  // tenant with a larger file gets a clear error, not a silently truncated
  // or hung import.
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(20000),
  // Optional — returned by POST /datasets/import-images (a real, prior
  // upload of a ZIP of product images). Ownership (tenantId match) is
  // re-verified server-side when this is resolved, never trusted from the
  // token alone (see dataset.controller.ts's startImport()).
  imageZipRef: z.string().trim().min(1).optional(),
});

export const previewImageMatchSchema = z.object({
  imageZipRef: z.string().trim().min(1),
  declaredFilenames: z.array(z.string()).max(20000),
});

export const toggleAvailableSchema = z.object({
  availableToChatbot: z.boolean(),
});
