/**
 * One-time migration: generate app login credentials for existing staff &
 * customers that don't have them yet. Safe to re-run (skips docs with creds).
 * Note: credentials are also lazily generated the first time an admin opens
 * the Credentials tab — this script is optional hygiene.
 * Run with: npx ts-node --project tsconfig.json src/scripts/backfill-app-credentials.ts
 */
import mongoose from 'mongoose';
import { config } from '../config';
import { NativeStaff } from '../modules/native-crm/staffs/staff.model';
import { NativeCustomer } from '../modules/native-crm/customers/customer.model';
import { ensureCredentials } from '../modules/native-crm/shared/app-credentials.service';

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB');

  const staffs = await NativeStaff.find({ appUsername: { $exists: false } })
    .select('_id tenantId firstName')
    .lean();
  console.log(`Found ${staffs.length} staff without credentials`);
  for (const s of staffs) {
    await ensureCredentials(NativeStaff, s._id, s.tenantId, (s as any).firstName ?? '');
    console.log(`  ✓ staff ${s._id}`);
  }

  const customers = await NativeCustomer.find({ appUsername: { $exists: false } })
    .select('_id tenantId name')
    .lean();
  console.log(`Found ${customers.length} customers without credentials`);
  for (const c of customers) {
    await ensureCredentials(NativeCustomer, c._id, c.tenantId, (c as any).name ?? '');
    console.log(`  ✓ customer ${c._id}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
