import mongoose from 'mongoose';
import { NativeStaff } from './staff.model';
import { RoundRobinCursor } from './round-robin-cursor.model';
import { NativeTeam } from '../teams/team.model';
import { NativeService } from '../services/service.model';

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

/** Routes a chatbot-captured free-text service mention to the right team's
 * round-robin roster, instead of always falling back to the tenant's one
 * fixed defaultTeamId. Reuses the real, already-existing NativeService
 * catalog (via NativeTeam.serviceIds) rather than a new free-text list on
 * Team itself — a tenant admin picks real catalog services from a dropdown.
 * Case-insensitive substring match in both directions (either string
 * contains the other) so "cardiology checkup" matches a catalog service
 * named "Cardiology" and vice versa. First matching team wins; returns
 * `null` when nothing matches (or no `serviceText` was given at all), which
 * every caller treats as "fall through to defaultTeamId/tenant-wide,
 * exactly like today" — assignRoundRobin() itself needs zero changes. */
export async function resolveTeamForService(tenantId: string, serviceText?: string | null): Promise<string | null> {
  if (!serviceText?.trim()) return null;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const needle = serviceText.trim().toLowerCase();

  const teams = await NativeTeam.find({ tenantId: tid, status: 'active', serviceIds: { $exists: true, $ne: [] } })
    .select('_id serviceIds').lean();
  if (!teams.length) return null;

  const allServiceIds = teams.flatMap((t) => t.serviceIds ?? []);
  const services = await NativeService.find({ tenantId: tid, _id: { $in: allServiceIds } }).select('_id name').lean();
  const matchedServiceIds = new Set(
    services
      .filter((s) => {
        const name = s.name.toLowerCase();
        return name.includes(needle) || needle.includes(name);
      })
      .map((s) => String(s._id)),
  );
  if (!matchedServiceIds.size) return null;

  const team = teams.find((t) => (t.serviceIds ?? []).some((id) => matchedServiceIds.has(String(id))));
  return team ? String(team._id) : null;
}
