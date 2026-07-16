/**
 * Backfill clientId for all existing tenants.
 * Run: node add-client-ids.js
 */
const mongoose = require('mongoose');
const crypto   = require('crypto');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';

const tenantSchema = new mongoose.Schema({ clientId: String }, { strict: false });
const Tenant = mongoose.model('Tenant', tenantSchema, 'tenants');

function genId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. ADFE7895
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  const tenants = await Tenant.find({}).lean();
  console.log(`Total tenants found: ${tenants.length}`);

  let added = 0;
  const usedIds = new Set(tenants.map(t => t.clientId).filter(Boolean));

  for (const t of tenants) {
    if (t.clientId) {
      console.log(`  SKIP  ${String(t.name || t._id).padEnd(35)} — already has clientId: ${t.clientId}`);
      continue;
    }
    // Generate unique ID
    let id;
    do { id = genId(); } while (usedIds.has(id));
    usedIds.add(id);

    await Tenant.updateOne({ _id: t._id }, { $set: { clientId: id } });
    console.log(`  ADDED ${String(t.name || t._id).padEnd(35)} → clientId: ${id}`);
    added++;
  }

  console.log(`\nDone! ${added} tenant(s) updated.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
