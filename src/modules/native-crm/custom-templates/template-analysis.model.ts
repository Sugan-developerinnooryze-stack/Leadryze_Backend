import mongoose, { Schema, Document } from 'mongoose';

/**
 * Audit trail + quota backstop for the PDF/Image Template Analyzer. Not a job
 * queue — analysis is synchronous request/response; this just records that a
 * (paid) analysis call happened, for the per-tenant daily quota count and for
 * debugging repeated failures. The Mongo-backed count is a second guardrail
 * layer independent of the ai/ service's Redis rate limiter, which fails
 * OPEN (rate limiting silently disabled) if Redis is unavailable.
 */
export interface ITemplateAnalysisLog extends Document {
  tenantId:      mongoose.Types.ObjectId;
  docType:       string;
  mimetype:      string;
  size:          number;
  status:        'success' | 'error';
  warningsCount: number;
  errorMessage?: string;
  createdAt:     Date;
}

const schema = new Schema<ITemplateAnalysisLog>(
  {
    tenantId:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    docType:       { type: String, required: true },
    mimetype:      { type: String, required: true },
    size:          { type: Number, required: true },
    status:        { type: String, enum: ['success', 'error'], required: true },
    warningsCount: { type: Number, default: 0 },
    errorMessage:  { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

schema.index({ tenantId: 1, createdAt: -1 });

export const TemplateAnalysisLog = mongoose.model<ITemplateAnalysisLog>(
  'TemplateAnalysisLog',
  schema,
  'native_template_analysis_logs'
);
