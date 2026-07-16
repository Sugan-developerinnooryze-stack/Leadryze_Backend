/**
 * Backfill clientId on ALL existing documents across every collection.
 * clientId is copied from the tenant that owns each document.
 * Run: node backfill-all-clientids.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';

// All collections that store tenantId
const COLLECTIONS = [
  // Native CRM
  'crm_contacts',
  'crm_companies',
  'crm_deals',
  'crm_tasks',
  'crm_tickets',
  'crm_calls',
  'crm_meetings',
  // Field Service
  'native_customers',
  'native_workorders',
  'native_invoices',
  'native_quotations',
  'native_contracts',
  'native_receipts',
  'native_expenses',
  'native_activities',
  'native_assets',
  'native_vehicles',
  'native_parts',
  'native_products',
  'native_services',
  'native_staffs',
  'native_sites',
  'native_teams',
  'native_categories',
];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);
  const db = mongoose.connection.db;

  // Build tenantId → clientId map from tenants collection
  const tenants = await db.collection('tenants').find({}).toArray();
  const tenantMap = {};
  for (const t of tenants) {
    tenantMap[t._id.toString()] = t.clientId || null;
  }
  console.log(`Loaded ${tenants.length} tenant(s)\n`);

  // Get actual collection names from DB
  const existingCols = (await db.listCollections().toArray()).map(c => c.name);

  let grandTotal = 0;

  for (const colName of COLLECTIONS) {
    if (!existingCols.includes(colName)) {
      console.log(`  [SKIP] ${colName} — collection not found`);
      continue;
    }

    const col = db.collection(colName);
    const docs = await col.find({ clientId: { $exists: false } }).toArray();

    if (docs.length === 0) {
      console.log(`  [OK]   ${colName} — nothing to update`);
      continue;
    }

    let updated = 0;
    let warned  = 0;

    for (const doc of docs) {
      const cid = tenantMap[doc.tenantId?.toString()];
      if (!cid) { warned++; continue; }
      await col.updateOne({ _id: doc._id }, { $set: { clientId: cid } });
      updated++;
    }

    console.log(`  [SET]  ${colName} — ${updated} doc(s) updated${warned ? `, ${warned} skipped (no clientId on tenant)` : ''}`);
    grandTotal += updated;
  }

  console.log(`\nDone! ${grandTotal} total document(s) updated across all collections.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
