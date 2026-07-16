/**
 * One-time migration: encrypt plaintext connector credentials that were stored
 * before field-level encryption was introduced.
 *
 * Run ONCE in a maintenance window:
 *   cd backend && npx ts-node scripts/migrate-encrypt-connectors.ts
 *
 * Safe to run multiple times — isEncrypted() guard prevents double-encryption.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Connector } from '../src/modules/connectors/connector.model';
import { encrypt, isEncrypted } from '../src/utils/crypto';

const SENSITIVE_FIELDS = ['password', 'uri', 'apiKey', 'accessToken', 'refreshToken', 'webhookSecret'] as const;

async function run() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const connectors = await Connector.find({}).select(
    '+config.password +config.uri +config.apiKey +config.accessToken +config.refreshToken +config.webhookSecret'
  );

  console.log(`Found ${connectors.length} connectors to inspect`);

  let migrated = 0;
  let skipped = 0;

  for (const connector of connectors) {
    const cfg = connector.config as Record<string, unknown>;
    let changed = false;

    for (const field of SENSITIVE_FIELDS) {
      const val = cfg[field];
      if (val && typeof val === 'string' && !isEncrypted(val)) {
        cfg[field] = encrypt(val);
        changed = true;
      }
    }

    if (changed) {
      await Connector.findByIdAndUpdate(connector._id, { config: cfg });
      migrated++;
      console.log(`Migrated connector: ${connector.name} (${connector.type})`);
    } else {
      skipped++;
    }
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} already encrypted or no sensitive fields`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
