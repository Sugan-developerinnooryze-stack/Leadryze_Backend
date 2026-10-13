import mongoose, { Schema, Document } from 'mongoose';

export interface ISequenceCounterDoc extends Document {
  tenantId: mongoose.Types.ObjectId;
  entity: string;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ISequenceCounterDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    entity:   { type: String, required: true },
    seq:      { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1, entity: 1 }, { unique: true });

export const SequenceCounter = mongoose.model<ISequenceCounterDoc>(
  'SequenceCounter',
  schema,
  'sequence_counters'
);

/**
 * Generate the next monotonic sequence number for a given tenant and entity.
 * Sequence numbers only ever increase and are never re-issued after deletions.
 */
export async function getNextSequence(
  tenantId: mongoose.Types.ObjectId,
  entity: string,
  model: mongoose.Model<any>
): Promise<number> {
  const maxDoc = await model
    .findOne({ tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  const currentMax = Number((maxDoc as any)?.numId) || 0;

  const counter = await SequenceCounter.findOneAndUpdate(
    { tenantId, entity },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (counter.seq <= currentMax) {
    const adjusted = await SequenceCounter.findOneAndUpdate(
      { tenantId, entity },
      { $set: { seq: currentMax + 1 } },
      { new: true }
    );
    return adjusted?.seq ?? currentMax + 1;
  }

  return counter.seq;
}
