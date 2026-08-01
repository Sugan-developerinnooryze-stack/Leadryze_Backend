import mongoose, { Schema, Document } from 'mongoose';

/**
 * AI-searchable product/catalog content — distinct from NativeProduct
 * (native-crm/products), which is a staff-managed inventory/pricing entity
 * for quotes and invoices. This collection holds marketing/spec-rich content
 * sourced from a website crawl or a bulk import, meant for the AI widget to
 * search and describe to visitors — a different shape and a different
 * lifecycle, kept as a separate collection on purpose (see the plan's
 * "Refinements" note for why reusing NativeProduct would have been wrong).
 */
export interface ICatalogItem extends Document {
  tenantId: mongoose.Types.ObjectId;
  branchId?: mongoose.Types.ObjectId | null;
  source: 'crawl' | 'import' | 'manual';
  knowledgeSourceId?: mongoose.Types.ObjectId;
  sourceUrl?: string; // the crawled page this came from, if source === 'crawl'
  sku?: string;
  productCode?: string;
  category?: string;
  subCategory?: string;
  title: string;
  shortDescription?: string;
  longDescription?: string;
  specifications?: Record<string, string>;
  attributes?: Record<string, string>;
  pdfs?: string[];
  images?: string[];
  videos?: string[];
  tags?: string[];
  contentHash: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const catalogItemSchema = new Schema<ICatalogItem>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    source: { type: String, enum: ['crawl', 'import', 'manual'], required: true },
    knowledgeSourceId: { type: Schema.Types.ObjectId, ref: 'KnowledgeSource' },
    sourceUrl: { type: String, trim: true },
    sku: { type: String, trim: true },
    productCode: { type: String, trim: true },
    category: { type: String, trim: true },
    subCategory: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    shortDescription: { type: String },
    longDescription: { type: String },
    specifications: { type: Schema.Types.Mixed, default: {} },
    attributes: { type: Schema.Types.Mixed, default: {} },
    pdfs: { type: [String], default: [] },
    images: { type: [String], default: [] },
    videos: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    contentHash: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

catalogItemSchema.index({ tenantId: 1 });
catalogItemSchema.index({ tenantId: 1, category: 1 });
catalogItemSchema.index({ tenantId: 1, sku: 1 }, { sparse: true });
// A plain sparse index would still collide on an explicit `sourceUrl: null`
// (sparse only excludes a field that's genuinely ABSENT, not one present
// with a null value) — a partial index with an explicit $exists filter is
// the correct way to make this unique only when sourceUrl is really set.
catalogItemSchema.index(
  { tenantId: 1, sourceUrl: 1 },
  { unique: true, partialFilterExpression: { sourceUrl: { $exists: true, $type: 'string' } } }
);
catalogItemSchema.index(
  { title: 'text', shortDescription: 'text', longDescription: 'text', tags: 'text' },
  { name: 'catalog_text_search' }
);

export const CatalogItem = mongoose.model<ICatalogItem>(
  'CatalogItem',
  catalogItemSchema,
  'native_catalog_items'
);
