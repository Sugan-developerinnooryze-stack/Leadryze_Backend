/**
 * One-time migration: populate emailDomain/phoneSearch on every existing Lead
 * created before native-crm/lead-import (Phase 5) added these fields.
 *
 * Both are derived, unencrypted, indexed fields used to detect duplicate/
 * same-company leads during CSV import WITHOUT decrypting every candidate
 * (Lead.email/phone are PII-encrypted at rest) — leads saved before this
 * migration have neither field set, so import's dedup/triage logic silently
 * treats them as if they don't exist until they're backfilled here.
 *
 * Run ONCE:
 *   cd backend && npx ts-node scripts/backfill-lead-search-fields.ts
 *
 * Safe to run multiple times — recomputes both fields from the current
 * (decrypted) email/phone every time, so re-running just re-derives the same
 * values for docs that already have them.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Lead } from '../src/modules/native-crm/leads/lead.model';
import { decrypt, isEncrypted } from '../src/utils/crypto';

function emailDomainOf(email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase().trim() : undefined;
}

function phoneSearchOf(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits || undefined;
}

async function run() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const leads = await Lead.find({}).select('email phone emailDomain phoneSearch').lean();
  console.log(`Found ${leads.length} leads to inspect`);

  let updated = 0;
  let skipped = 0;

  for (const lead of leads) {
    const plainEmail = lead.email && isEncrypted(lead.email) ? decrypt(lead.email) : lead.email;
    const plainPhone = lead.phone && isEncrypted(lead.phone) ? decrypt(lead.phone) : lead.phone;
    const emailDomain = emailDomainOf(plainEmail);
    const phoneSearch = phoneSearchOf(plainPhone);

    if (emailDomain === lead.emailDomain && phoneSearch === lead.phoneSearch) {
      skipped++;
      continue;
    }

    await Lead.updateOne(
      { _id: lead._id },
      { $set: { emailDomain: emailDomain ?? null, phoneSearch: phoneSearch ?? null } },
    );
    updated++;
  }

  console.log(`\nBackfill complete: ${updated} updated, ${skipped} already correct`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
