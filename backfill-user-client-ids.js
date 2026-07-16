/**
 * Backfill clientId onto all existing user documents.
 * Each user's clientId is copied from their tenant's clientId.
 * Run: node backfill-user-client-ids.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';

const tenantSchema = new mongoose.Schema({ clientId: String }, { strict: false });
const Tenant = mongoose.model('Tenant', tenantSchema, 'tenants');

const userSchema = new mongoose.Schema({ tenantId: mongoose.Schema.Types.ObjectId, clientId: String }, { strict: false });
const User = mongoose.model('User', userSchema, 'users');

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  const tenants = await Tenant.find({}).lean();
  const tenantMap = {};
  for (const t of tenants) {
    tenantMap[t._id.toString()] = t.clientId;
  }
  console.log(`Loaded ${tenants.length} tenant(s)`);

  const users = await User.find({}).lean();
  console.log(`Total users found: ${users.length}`);

  let updated = 0;
  let skipped = 0;

  for (const u of users) {
    if (u.clientId) {
      console.log(`  SKIP  ${String(u.email).padEnd(40)} — already has clientId: ${u.clientId}`);
      skipped++;
      continue;
    }
    const cid = tenantMap[u.tenantId?.toString()];
    if (!cid) {
      console.log(`  WARN  ${String(u.email).padEnd(40)} — tenant has no clientId, skipping`);
      continue;
    }
    await User.updateOne({ _id: u._id }, { $set: { clientId: cid } });
    console.log(`  SET   ${String(u.email).padEnd(40)} → clientId: ${cid}`);
    updated++;
  }

  console.log(`\nDone! ${updated} user(s) updated, ${skipped} already had clientId.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
