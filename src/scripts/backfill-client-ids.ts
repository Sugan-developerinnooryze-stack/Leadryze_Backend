/**
 * One-time migration: assign a unique clientId to every existing tenant that doesn't have one.
 * Run with: npx ts-node --project tsconfig.json src/scripts/backfill-client-ids.ts
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Tenant } from '../modules/tenants/tenant.model';
import { config } from '../config';

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB');

  const tenants = await Tenant.find({ clientId: { $exists: false } }).lean();
  console.log(`Found ${tenants.length} tenant(s) without clientId`);

  for (const t of tenants) {
    let id: string;
    let tries = 0;
    do {
      id = crypto.randomBytes(4).toString('hex').toUpperCase();
      tries++;
    } while (tries < 20 && await Tenant.exists({ clientId: id }));

    await Tenant.updateOne({ _id: t._id }, { $set: { clientId: id } });
    console.log(`  ✓ ${t.name.padEnd(30)} → clientId: ${id}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
