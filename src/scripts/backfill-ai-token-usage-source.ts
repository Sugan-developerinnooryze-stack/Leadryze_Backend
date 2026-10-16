/**
 * One-time migration: every AiTokenUsage doc that predates the new `source`
 * discriminator (added so the internal CRM assistant's usage can be tracked
 * separately from the public widget's, while still summing into one shared
 * tenant allowance) is real public-widget (+ continuous-voice) usage —
 * there was no other writer of this collection before today. Backfilled to
 * source: 'public_widget' explicitly, never inferred at read time.
 *
 * Idempotent: the $set filter only matches docs with no `source` field, so
 * re-running finds nothing to update the second time.
 *
 * Also drops the old `{tenantId:1,date:1}` unique index (superseded by
 * `{tenantId:1,date:1,source:1}`, which the model now declares) if present
 * — left in place would otherwise reject the first `internal_assistant` doc
 * for a tenant/date that already has a `public_widget` doc.
 *
 * Run with: npx ts-node --project tsconfig.json src/scripts/backfill-ai-token-usage-source.ts
 */
import mongoose from 'mongoose';
import { AiTokenUsage } from '../modules/admin/ai-token-usage.model';
import { config } from '../config';

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB');

  const result = await AiTokenUsage.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'public_widget' } }
  );
  console.log(`Backfilled source on ${result.modifiedCount} doc(s) (matched ${result.matchedCount}).`);

  const indexes = await AiTokenUsage.collection.indexes();
  const staleIndex = indexes.find(
    (ix) => ix.key && Object.keys(ix.key).length === 2 && ix.key.tenantId === 1 && ix.key.date === 1 && ix.unique
  );
  if (staleIndex?.name) {
    await AiTokenUsage.collection.dropIndex(staleIndex.name);
    console.log(`Dropped stale index "${staleIndex.name}" ({tenantId:1,date:1} unique).`);
  } else {
    console.log('No stale {tenantId:1,date:1} unique index found — nothing to drop.');
  }

  await AiTokenUsage.syncIndexes();
  console.log('Synced indexes (new {tenantId:1,date:1,source:1} unique index now in place).');

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
