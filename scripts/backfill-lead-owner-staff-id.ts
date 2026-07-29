/**
 * One-time migration: best-effort match existing Lead.leadOwner free-text
 * values against NativeStaff (same tenant, case-insensitive full-name match)
 * and stamp leadOwnerStaffId where exactly one match is found.
 *
 * Why this exists: leadOwner was always a free-text string with no real
 * staff link, so automation rules' 'assigned_user' recipient strategy could
 * never resolve a Lead owner to a real recipient. leadOwnerStaffId is the
 * new real reference (native-crm/leads/lead.model.ts) — going forward the
 * Lead form writes both fields together, but pre-existing leads only have
 * the free-text leadOwner, hence this backfill.
 *
 * Deliberately conservative: only sets leadOwnerStaffId when the name
 * matches EXACTLY ONE active staff member for that tenant — an ambiguous
 * (multiple staff share a name) or unmatched leadOwner is left alone rather
 * than guessing, since automation would otherwise silently email the wrong
 * person.
 *
 * Run ONCE:
 *   cd backend && npx ts-node scripts/backfill-lead-owner-staff-id.ts
 *
 * Safe to re-run: only touches leads where leadOwnerStaffId is still unset.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Lead } from '../src/modules/native-crm/leads/lead.model';
import { NativeStaff } from '../src/modules/native-crm/staffs/staff.model';

async function run() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const leads = await Lead.find({
    leadOwner: { $exists: true, $ne: '' },
    leadOwnerStaffId: { $exists: false },
  }).select('_id tenantId leadOwner').lean();
  console.log(`Found ${leads.length} lead(s) with a leadOwner but no leadOwnerStaffId`);

  const staffByTenant = new Map<string, { staffId: string; fullName: string }[]>();
  async function staffFor(tenantId: mongoose.Types.ObjectId) {
    const key = tenantId.toString();
    if (!staffByTenant.has(key)) {
      const staff = await NativeStaff.find({ tenantId }).select('staffId firstName lastName').lean();
      staffByTenant.set(key, staff.map((s: any) => ({
        staffId: s.staffId,
        fullName: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim().toLowerCase(),
      })));
    }
    return staffByTenant.get(key)!;
  }

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const lead of leads) {
    const name = (lead.leadOwner ?? '').trim().toLowerCase();
    if (!name) continue;
    const staff = await staffFor(lead.tenantId as mongoose.Types.ObjectId);
    const candidates = staff.filter((s) => s.fullName === name);

    if (candidates.length === 1) {
      await Lead.updateOne({ _id: lead._id }, { $set: { leadOwnerStaffId: candidates[0].staffId } });
      matched++;
    } else if (candidates.length > 1) {
      ambiguous++;
    } else {
      unmatched++;
    }
  }

  console.log(`\nBackfill complete: ${matched} matched, ${ambiguous} ambiguous (skipped), ${unmatched} unmatched (skipped)`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
