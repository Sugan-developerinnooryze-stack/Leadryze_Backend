import mongoose from 'mongoose';
import { NativeStaff } from '../staffs/staff.model';
import { NativeTeam } from '../teams/team.model';
import { User } from '../../auth/auth.model';

/** Resolves the denormalized display convenience Lead.teamId/teamName and
 * Meeting.teamId/teamName fields from a business staffId — mirrors the
 * exact same "look up once at assignment time, store for display" pattern
 * already used for assignedStaffName. Returns nulls when the staff member
 * has no team (or doesn't exist) rather than throwing — a Lead/Meeting with
 * no assignable team is a normal, common case (a tenant with no Teams
 * configured at all), never an error. */
export async function resolveTeamFromStaffId(
  tenantId: string,
  staffId?: string | null,
): Promise<{ teamId: string | null; teamName: string | null }> {
  if (!staffId) return { teamId: null, teamName: null };
  const tid = new mongoose.Types.ObjectId(tenantId);
  const staff = await NativeStaff.findOne({ tenantId: tid, staffId }).select('teamId').lean();
  if (!staff?.teamId) return { teamId: null, teamName: null };
  const team = await NativeTeam.findOne({ _id: staff.teamId, tenantId: tid }).select('name').lean();
  if (!team) return { teamId: null, teamName: null };
  return { teamId: String(staff.teamId), teamName: team.name };
}

/** Live-resolves a team's manager display name at READ time (never stored
 * on the Lead/Meeting itself — a team's manager can change independently of
 * any given record, so denormalizing this would risk silent staleness).
 * Returns null when the team has no manager set, or teamId is absent —
 * both normal, expected cases matching this codebase's existing
 * 'manager' automation-recipient fallback posture. */
export async function resolveSupervisorName(tenantId: string, teamId?: string | null): Promise<string | null> {
  if (!teamId || !mongoose.isValidObjectId(teamId)) return null;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const team = await NativeTeam.findOne({ _id: teamId, tenantId: tid }).select('managerUserId').lean();
  if (!team?.managerUserId) return null;
  const manager = await User.findById(team.managerUserId).select('firstName lastName email').lean();
  if (!manager) return null;
  return [manager.firstName, manager.lastName].filter(Boolean).join(' ') || manager.email;
}
