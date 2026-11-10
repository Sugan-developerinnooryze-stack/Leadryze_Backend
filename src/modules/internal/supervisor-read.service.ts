/** Read-only Supervisor lookups for the internal CRM assistant gateway.
 *
 * A "Supervisor" has no model of its own: it is a login User with role
 * MANAGER that is not deactivated (isActive !== false) — the same definition
 * the sidebar badge (fs-counts.controller.ts) and SupervisorsPage.tsx use.
 * The teams a supervisor manages come from NativeTeam.managerUserId.
 * Tenant-wide, like both of those screens (no branch or row-level scope).
 *
 * Only the fields in SUPERVISOR_SELECT are ever read from the database (an
 * inclusion projection), so the password hash, refresh token, verification/
 * reset tokens, encrypted password copy and any other credential can never be
 * loaded here, let alone returned. */

import mongoose from 'mongoose';
import { User } from '../auth/auth.model';
import { NativeTeam } from '../native-crm/teams/team.model';
import { escapeRegex } from '../../utils/escape-regex';

/** The ONLY User fields this service reads. Never add a credential or token. */
const SUPERVISOR_SELECT = '_id firstName lastName email';

function supervisorFilter(tenantId: string): Record<string, unknown> {
  return { tenantId: new mongoose.Types.ObjectId(tenantId), role: 'MANAGER', isActive: { $ne: false } };
}

/** Adds `teamNames` (the teams each supervisor manages, by name). */
async function withTeamNames(tenantId: string, users: any[]): Promise<any[]> {
  if (users.length === 0) return users;
  const teams = await NativeTeam.find({
    tenantId: new mongoose.Types.ObjectId(tenantId),
    managerUserId: { $in: users.map((u) => u._id) },
  }).select('name managerUserId').lean();
  const byManager = new Map<string, string[]>();
  for (const team of teams as any[]) {
    const key = String(team.managerUserId);
    byManager.set(key, [...(byManager.get(key) ?? []), team.name].filter(Boolean));
  }
  return users.map((u) => ({
    _id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email,
    teamNames: byManager.get(String(u._id)) ?? [],
  }));
}

export async function listSupervisors(
  tenantId: string, opts: { search?: string; limit?: number; page?: number } = {},
): Promise<{ items: any[]; total: number }> {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 100));
  const page = Math.max(1, Number(opts.page) || 1);
  const filter = supervisorFilter(tenantId);
  const search = typeof opts.search === 'string' ? opts.search.trim() : '';
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
  }
  const [users, total] = await Promise.all([
    User.find(filter).select(SUPERVISOR_SELECT).sort({ firstName: 1, lastName: 1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  return { items: await withTeamNames(tenantId, users as any[]), total };
}

export async function getSupervisorById(id: string, tenantId: string): Promise<any | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  const user = await User.findOne({ ...supervisorFilter(tenantId), _id: new mongoose.Types.ObjectId(id) })
    .select(SUPERVISOR_SELECT).lean();
  if (!user) return null;
  const [withTeams] = await withTeamNames(tenantId, [user]);
  return withTeams;
}
