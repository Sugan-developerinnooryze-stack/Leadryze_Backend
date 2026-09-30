/**
 * One-time migration: propagate each tenant's clientId onto its TENANT_ADMIN
 * user(s) that are missing it. registerUser()/provisionTenant() have always
 * set User.clientId at creation time, but older accounts created before that
 * (or via one-off dev scripts) can have a Tenant.clientId with no matching
 * User.clientId — which is what the Client-ID login path actually queries
 * against (User.findOne({tenantId, clientId})), so those accounts can't log
 * in via Client ID until this runs. Ensures every tenant has a clientId
 * first (same logic as backfill-client-ids.ts), then stamps it onto any
 * TENANT_ADMIN missing it. Safe to re-run — only touches users with no
 * clientId set.
 *
 * Run with: npx ts-node --project tsconfig.json src/scripts/backfill-user-client-ids.ts
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Tenant } from '../modules/tenants/tenant.model';
import { User } from '../modules/auth/auth.model';
import { config } from '../config';

async function run() {
  await mongoose.connect(config.mongodb.uri);
  console.log('Connected to MongoDB:', config.mongodb.uri);

  const tenants = await Tenant.find({}).select('_id name clientId').lean();
  let tenantsAssigned = 0;
  let usersAssigned = 0;

  for (const t of tenants) {
    let clientId = (t as any).clientId as string | undefined;
    if (!clientId) {
      let tries = 0;
      do {
        clientId = crypto.randomBytes(4).toString('hex').toUpperCase();
        tries++;
      } while (tries < 20 && await Tenant.exists({ clientId }));
      await Tenant.updateOne({ _id: t._id }, { $set: { clientId } });
      tenantsAssigned++;
      console.log(`  tenant ${(t as any).name ?? t._id} → new clientId ${clientId}`);
    }

    const res = await User.updateMany(
      { tenantId: t._id, role: 'TENANT_ADMIN', $or: [{ clientId: { $exists: false } }, { clientId: null }, { clientId: '' }] },
      { $set: { clientId } },
    );
    if (res.modifiedCount) {
      usersAssigned += res.modifiedCount;
      console.log(`  ✓ ${(t as any).name ?? t._id}: stamped clientId ${clientId} onto ${res.modifiedCount} TENANT_ADMIN user(s)`);
    }
  }

  console.log(`\nDone. ${tenantsAssigned} tenant(s) got a new clientId; ${usersAssigned} user(s) backfilled.`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
