import mongoose from 'mongoose';
import { NativeTeam } from './team.model';
import { TeamListOptions } from './team.types';
import { DataScope } from '../../../types';
import { applyDataScopeToTeamFilter } from '../shared/data-scope';
import { NativeStaff } from '../staffs/staff.model';
import { Lead } from '../leads/lead.model';
import { Meeting } from '../meetings/meeting.model';
import { NativeCustomer } from '../customers/customer.model';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listTeams(tenantId: string, opts: TeamListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToTeamFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.name   = new RegExp(opts.search, 'i');
  if (opts.showInWidget !== undefined) filter.showInWidget = opts.showInWidget;

  const [items, total] = await Promise.all([
    NativeTeam.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeTeam.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getTeamById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeTeam.findOne({ _id: id, tenantId: tid });
}

/** Case-insensitive duplicate check within the tenant — "Team A" and
 * "team a" are the same name to a user picking from a dropdown, even though
 * Mongo would happily store both as distinct strings. `excludeId` lets
 * updateTeam() re-use this without flagging a team against its own name. */
async function assertUniqueTeamName(tenantId: mongoose.Types.ObjectId, name: string, excludeId?: string): Promise<void> {
  const filter: any = { tenantId, name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await NativeTeam.findOne(filter).select('_id').lean();
  if (existing) throw new Error(`A team named "${name.trim()}" already exists`);
}

export async function createTeam(data: any) {
  if (data.name) await assertUniqueTeamName(new mongoose.Types.ObjectId(data.tenantId), data.name);
  const doc = await NativeTeam.create(data);
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'teams', doc.toObject(), doc.name);
  return doc;
}

export async function updateTeam(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  // Same row-level enforcement listTeams already applies to the list view —
  // without this, a scoped Manager who knows/guesses another team's id could
  // reassign its managerUserId onto themselves (or unassign it) via a direct
  // API call, even though that team never appears in their own scoped list.
  // A scoped caller may only touch a team already inside their own scope —
  // claiming a brand-new unassigned team stays an Admin-driven action here,
  // same as create() already is.
  if (scope && scope.kind !== 'all' && !scope.teamIds.includes(id)) return null;
  if (data.name) await assertUniqueTeamName(tid, data.name, id);
  const updated = await NativeTeam.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'teams', updated.toObject(), updated.name);
  return updated;
}

export async function deleteTeam(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const deleted = await NativeTeam.findOneAndDelete({ _id: id, tenantId: tid });
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'teams', String(deleted._id));
  return deleted;
}

/** Real, per-TEAM Lead/Meeting/Customer counts — computed server-side from
 * the team's own active staff roster, not from whoever happens to be
 * logged in. This is deliberately a different thing from the existing
 * row-level DataScope system (which answers "what can THIS logged-in user
 * see"): a Tenant Admin looking at Team X's own page, or a Supervisor
 * listing page showing every team at once, both need Team X's OWN numbers
 * specifically, not the viewer's own scope. Used by both the Team detail
 * page and the Supervisors listing page (summed across a supervisor's
 * managed teams). */
export async function getTeamStats(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const team = await NativeTeam.findOne({ _id: id, tenantId: tid }).lean();
  if (!team) return null;

  const roster = await NativeStaff.find({ tenantId: tid, teamId: new mongoose.Types.ObjectId(id), status: 'active' })
    .select('staffId').lean();
  const staffIds = roster.map((s) => s.staffId);

  if (!staffIds.length) return { staffCount: 0, leads: 0, meetings: 0, customers: 0 };

  const [leads, meetings, customers] = await Promise.all([
    Lead.countDocuments({ tenantId: tid, leadOwnerStaffId: { $in: staffIds } }),
    Meeting.countDocuments({ tenantId: tid, assignedStaffId: { $in: staffIds } }),
    NativeCustomer.countDocuments({ tenantId: tid, assignedStaffId: { $in: staffIds } }),
  ]);

  return { staffCount: staffIds.length, leads, meetings, customers };
}
