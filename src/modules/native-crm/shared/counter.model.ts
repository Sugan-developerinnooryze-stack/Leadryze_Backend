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

const isDuplicateKey = (err: unknown): boolean => (err as { code?: number } | null)?.code === 11000;

/**
 * Generate the next monotonic sequence number for a given tenant and entity.
 * Sequence numbers only ever increase and are never re-issued after deletions.
 *
 * LR-C4-NUM-001: two atomic steps, so concurrent creates never share a number,
 * even when the counter is behind the records already stored (records older
 * than the counter, or rows inserted by a seed or script):
 *   1. $max lifts the counter to the highest number already in use. It never
 *      lowers the counter, so it cannot undo another request's increment.
 *   2. $inc hands this caller its own number.
 * The old version compared and then $set the counter, so two creates could
 * both read the same highest number and both return highest + 1, and the
 * $set could lower a counter another request had already moved on.
 *
 * `scope` narrows the "highest number in use" read to the records this
 * counter numbers (custom module records are numbered per module).
 */
export async function getNextSequence(
  tenantId: mongoose.Types.ObjectId,
  entity: string,
  model: mongoose.Model<any>,
  scope: Record<string, unknown> = {},
): Promise<number> {
  const maxDoc = await model
    .findOne({ ...scope, tenantId })
    .sort({ numId: -1 })
    .select('numId')
    .lean();
  const currentMax = Number((maxDoc as any)?.numId) || 0;

  const lift = () => SequenceCounter.updateOne({ tenantId, entity }, { $max: { seq: currentMax } }, { upsert: true });
  try {
    await lift();
  } catch (err) {
    // Two first-ever creates can race to insert the counter row; the loser's
    // insert hits the unique index. The row exists now, so lift it again.
    if (!isDuplicateKey(err)) throw err;
    await lift();
  }

  const counter = await SequenceCounter.findOneAndUpdate(
    { tenantId, entity },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return counter.seq;
}
