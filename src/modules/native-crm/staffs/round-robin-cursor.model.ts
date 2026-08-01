import mongoose, { Schema, Document } from 'mongoose';

/** Bookkeeping only — tracks rotation position for assignRoundRobin(), one
 * document per (tenant, scope). A tiny, dedicated collection rather than a
 * field bolted onto Team/Staff — avoids schema churn on those hot-path
 * models, and naturally covers the "no team configured, rotate tenant-wide"
 * case via the 'ALL' sentinel scopeKey. */
export interface IRoundRobinCursorDoc extends Document {
  tenantId: mongoose.Types.ObjectId;
  /** A Team's _id as a string, or the literal 'ALL' sentinel for tenant-wide
   * rotation across every active staff member regardless of team. */
  scopeKey: string;
  cursor: number;
}

const schema = new Schema<IRoundRobinCursorDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    scopeKey: { type: String, required: true },
    cursor:   { type: Number, default: 0 },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, scopeKey: 1 }, { unique: true });

export const RoundRobinCursor = mongoose.model<IRoundRobinCursorDoc>(
  'RoundRobinCursor',
  schema,
  'native_round_robin_cursors',
);
