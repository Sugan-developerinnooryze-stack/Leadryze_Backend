import mongoose from 'mongoose';
import { Response, NextFunction } from 'express';
import { AuthRequest, DataScope, JwtPayload } from '../../../types';
import { NativeTeam } from '../teams/team.model';
import { NativeStaff } from '../staffs/staff.model';

/** Row-level data-scoping decision for a request, computed once from the
 * authenticated user's role plus the (optional) NativeTeam.managerUserId /
 * NativeStaff.userId links — see the plan's own "closing the role is just
 * a label gap" write-up for why this exists. SUPER_ADMIN/TENANT_ADMIN keep
 * today's exact unscoped behavior; MANAGER/AGENT get a real, new filter. */
export async function resolveDataScope(tenantId: string, user: JwtPayload): Promise<DataScope> {
  if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
    return { kind: 'all', staffIds: [], teamIds: [] };
  }

  const tid = new mongoose.Types.ObjectId(tenantId);
  const uid = new mongoose.Types.ObjectId(user.userId);

  if (user.role === 'MANAGER') {
    const managedTeams = await NativeTeam.find({ tenantId: tid, managerUserId: uid }).select('_id').lean();
    const teamObjectIds = managedTeams.map((t) => t._id);
    const staffInTeams = teamObjectIds.length
      ? await NativeStaff.find({ tenantId: tid, teamId: { $in: teamObjectIds } }).select('staffId teamId').lean()
      : [];
    const ownStaff = await NativeStaff.findOne({ tenantId: tid, userId: uid }).select('staffId teamId').lean();

    const staffIds = new Set(staffInTeams.map((s) => s.staffId));
    const teamIds = new Set(teamObjectIds.map(String));
    if (ownStaff) {
      staffIds.add(ownStaff.staffId);
      if (ownStaff.teamId) teamIds.add(String(ownStaff.teamId));
    }
    return { kind: 'team', staffIds: Array.from(staffIds), teamIds: Array.from(teamIds) };
  }

  // AGENT / USER (legacy alias of AGENT) — scoped to their own linked Staff
  // profile only. No linked profile → staffIds/teamIds stay empty, which
  // every caller must treat as "matches nothing", never "unscoped".
  const ownStaff = await NativeStaff.findOne({ tenantId: tid, userId: uid }).select('staffId teamId').lean();
  return {
    kind: 'self',
    staffIds: ownStaff ? [ownStaff.staffId] : [],
    teamIds: ownStaff?.teamId ? [String(ownStaff.teamId)] : [],
  };
}

export async function resolveDataScopeMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user || !req.tenantId) { next(); return; }
  try {
    req.dataScope = await resolveDataScope(req.tenantId, req.user);
  } catch {
    // Fail closed, not open — an error resolving scope must never silently
    // grant unscoped access. 'self' + empty staffIds/teamIds matches nothing.
    req.dataScope = { kind: 'self', staffIds: [], teamIds: [] };
  }
  next();
}

/** Small shared helpers every scoped module's filter-builder calls the same
 * way — mirrors how branchId scoping is already applied ad hoc per module,
 * just centralizing the "how do I turn a DataScope into a Mongo filter
 * fragment" logic in one place instead of copy-pasting the if/else 5 times. */
export function applyDataScopeToFilter(filter: Record<string, unknown>, scope: DataScope | undefined, ownerField: string): void {
  if (!scope || scope.kind === 'all') return;
  filter[ownerField] = { $in: scope.staffIds };
}

/** Same idea, for the Teams list itself (keyed on _id/teamIds rather than
 * an ownerField/staffIds — a Manager sees the teams they manage, an Agent
 * sees only their own team, if linked to one). */
export function applyDataScopeToTeamFilter(filter: Record<string, unknown>, scope: DataScope | undefined): void {
  if (!scope || scope.kind === 'all') return;
  filter._id = { $in: scope.teamIds.map((id) => new mongoose.Types.ObjectId(id)) };
}
