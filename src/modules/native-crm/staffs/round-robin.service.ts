import mongoose from 'mongoose';
import { NativeStaff } from './staff.model';
import { RoundRobinCursor } from './round-robin-cursor.model';

/** Rotates through a tenant's active staff roster (optionally scoped to one
 * team) and returns the next one in line — used to auto-assign a Lead
 * captured via the AI widget. Genuinely new capability: confirmed via a
 * full-codebase search that no round-robin/rotation logic exists anywhere
 * else in this app; every existing recipient-resolution strategy
 * (resolveAutomationRecipient's record_contact/assigned_user/tenant_admin/
 * manager) picks a FIXED person, never "next in rotation".
 *
 * The cursor advance is a single atomic findOneAndUpdate($inc + upsert) —
 * deliberately NOT the read-then-increment-in-app-code pattern this
 * codebase's own numId auto-increment already accepts elsewhere (fine for a
 * display-only sequence number, not fine here: two concurrent widget
 * submissions must land on genuinely different, fairly-rotated staff). */
export async function assignRoundRobin(
  tenantId: string,
  teamId?: string | null,
): Promise<{ staffId: string; staffName: string } | null> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid, status: 'active' };
  if (teamId) filter.teamId = new mongoose.Types.ObjectId(teamId);

  const roster = await NativeStaff.find(filter)
    .select('staffId firstName lastName')
    .sort({ _id: 1 })
    .lean();
  if (roster.length === 0) return null;

  const scopeKey = teamId ?? 'ALL';
  const doc = await RoundRobinCursor.findOneAndUpdate(
    { tenantId: tid, scopeKey },
    { $inc: { cursor: 1 } },
    { upsert: true, new: true },
  );

  const idx = ((doc.cursor - 1) % roster.length + roster.length) % roster.length;
  const staff = roster[idx];
  return { staffId: staff.staffId, staffName: `${staff.firstName} ${staff.lastName}`.trim() };
}
