import mongoose, { Schema, Document } from 'mongoose';

/**
 * One structured "who we are / what we do" document per tenant, built once
 * per website crawl (not per-question) — the answer to "tell me about this
 * website" that plain RAG chunk-similarity search can never reliably produce
 * (there's no single page whose text chunk *is* "a summary of the whole
 * site"). Populated from real Organization/LocalBusiness/FAQPage JSON-LD
 * already parsed by the crawler (previously discarded entirely except for
 * Product), with an LLM-summarization fallback for the fields JSON-LD didn't
 * supply — see ai/src/rag/website-profile-extractor.ts. `hours` is
 * deliberately display-only: it never feeds bookable-slot computation, which
 * stays owned by `Tenant.widget.booking.hours` alone.
 */
export interface IWebsiteProfile extends Document {
  tenantId: mongoose.Types.ObjectId;
  branchId?: mongoose.Types.ObjectId | null;
  knowledgeSourceId?: mongoose.Types.ObjectId;
  summary?: string;
  services?: string[];
  contact?: {
    phone?: string;
    email?: string;
    address?: string;
  };
  hours?: string;
  staff?: Array<{ name: string; title?: string }>;
  faqs?: Array<{ question: string; answer: string }>;
  fieldSources: Record<string, 'jsonld' | 'llm'>;
  contentHash: string;
  lastBuiltAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const websiteProfileSchema = new Schema<IWebsiteProfile>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    knowledgeSourceId: { type: Schema.Types.ObjectId, ref: 'KnowledgeSource' },
    summary: { type: String },
    services: { type: [String], default: [] },
    contact: {
      phone: { type: String },
      email: { type: String },
      address: { type: String },
    },
    hours: { type: String },
    staff: {
      type: [{ name: { type: String, required: true }, title: { type: String } }],
      default: [],
    },
    faqs: {
      type: [{ question: { type: String, required: true }, answer: { type: String, required: true } }],
      default: [],
    },
    fieldSources: { type: Schema.Types.Mixed, default: {} },
    contentHash: { type: String, required: true },
    lastBuiltAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One profile per tenant — a crawl's re-run always updates this same doc.
websiteProfileSchema.index({ tenantId: 1 }, { unique: true });

export const WebsiteProfile = mongoose.model<IWebsiteProfile>(
  'WebsiteProfile',
  websiteProfileSchema,
  'native_website_profiles'
);
