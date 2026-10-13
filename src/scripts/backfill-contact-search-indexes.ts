import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillContactSearchIndices } from '../modules/native-crm/contacts/contact.service';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27018/leadryze';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const result = await backfillContactSearchIndices();
  console.log(`Backfill complete: scanned ${result.total} contact(s), updated ${result.backfilled} contact(s).`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
