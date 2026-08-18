import mongoose from 'mongoose';
import { Meeting } from './meeting.model';
import { CreateMeetingDTO, UpdateMeetingDTO } from './meeting.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { resolveTeamFromStaffId } from '../shared/team-resolution';
import { NativeTimeline } from '../timeline/timeline.model';
import { Tenant } from '../../tenants/tenant.model';
import { Lead } from '../leads/lead.model';
import { convertLeadToCustomer } from '../leads/lead-conversion.service';
import { NativeStaff } from '../staffs/staff.model';
import { isSlotFree } from './availability.service';

export async function listMeetings(tenantId: string, opts: ListOptions = {}, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId, upcoming } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  if (status) filter.meetingStatus = status;
  if (relatedModule && relatedId) { filter.relatedModule = relatedModule; filter.relatedId = relatedId; }
  if (upcoming) filter.startDate = { $gte: new Date() };
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { location: re }, { notes: re }];
  }
  const [items, total] = await Promise.all([
    Meeting.find(filter).sort({ startDate: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Meeting.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getMeetingById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  return Meeting.findOne(filter).lean();
}

export async function createMeeting(tenantId: string, dto: CreateMeetingDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Meeting.create({ tenantId: tid, ...dto });
  void sendOnCreateConfirmation(tenantId, 'meeting', created.toObject()); // fire-and-forget, never throws
  return created;
}

export async function updateMeeting(
  tenantId: string,
  id: string,
  dto: UpdateMeetingDTO,
  scope?: DataScope,
  performedBy?: string,
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');

  // Fetch the pre-update state first — needed to detect a real
  // reassignment (assignedStaffId actually changing) and a real
  // meetingStatus transition INTO 'completed', neither of which is knowable
  // from the update payload alone (a client could resend the same,
  // unchanged assignedStaffId). A separate read-then-write, not atomic —
  // an acceptable tradeoff for a staff-driven CRM edit (same pattern
  // already used by lead.controller.ts's own update()).
  const prev = await Meeting.findOne(filter).lean();
  if (!prev) return null;

  const update: Record<string, unknown> = { ...dto };
  const isReassignment = dto.assignedStaffId !== undefined && dto.assignedStaffId !== (prev as any).assignedStaffId;
  if (isReassignment) {
    // The server is the sole authority on teamId/teamName — always
    // re-resolved fresh from the new assignedStaffId, never trusted from
    // whatever the client happened to send alongside it.
    const { teamId, teamName } = await resolveTeamFromStaffId(tenantId, dto.assignedStaffId);
    update.teamId = teamId ?? undefined;
    update.teamName = teamName ?? undefined;
  }

  const updated = await Meeting.findOneAndUpdate(filter, { $set: update }, { new: true }).lean();
  if (!updated) return null;

  if (isReassignment) {
    const prevName = (prev as any).assignedStaffName || 'Unassigned';
    const newName = (updated as any).assignedStaffName || dto.assignedStaffId || 'Unassigned';
    await NativeTimeline.create({
      tenantId: tid,
      entityModule: 'meetings',
      entityId: id,
      action: 'reassigned',
      description: `Reassigned from ${prevName} to ${newName}${performedBy ? ` by ${performedBy}` : ''}`,
      performedBy,
      metadata: { previousStaffId: (prev as any).assignedStaffId, newStaffId: dto.assignedStaffId, teamId: update.teamId, teamName: update.teamName },
    }).catch(() => {});
  }

  // Opt-in auto-conversion: a completed, Lead-linked Meeting converts its
  // Lead to a Customer automatically, when the tenant has turned this on.
  // Idempotency Layer 1 — check isConverted BEFORE ever calling
  // convertLeadToCustomer, so a repeated/duplicate 'completed' update never
  // even attempts a second conversion (Layer 2 is convertLeadToCustomer's
  // own pre-existing conversionHistory guard, unchanged, which would also
  // reject a second attempt — this is defense in depth, not the only guard).
  const becameCompleted = dto.meetingStatus === 'completed' && (prev as any).meetingStatus !== 'completed';
  if (becameCompleted && (updated as any).relatedModule === 'lead' && (updated as any).relatedId) {
    void (async () => {
      try {
        const tenant = await Tenant.findById(tid).select('aiConfig.autoConvertLeadOnMeetingCompleted').lean();
        if (!tenant?.aiConfig?.autoConvertLeadOnMeetingCompleted) return;
        const lead = await Lead.findOne({ _id: (updated as any).relatedId, tenantId: tid }).select('isConverted').lean();
        if (!lead || lead.isConverted) return; // Layer 1 — already converted, or not a real Lead; do nothing
        await convertLeadToCustomer(tid, String((updated as any).relatedId), performedBy ?? 'system:auto-convert');
      } catch {
        // Never let auto-conversion failure affect the meeting update itself
        // — this runs fire-and-forget, same posture as every other
        // background side-effect in this codebase (automation rules, email).
      }
    })();
  }

  return updated;
}

export async function deleteMeeting(tenantId: string, id: string, scope?: DataScope): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const res = await Meeting.findOneAndDelete(filter);
  return !!res;
}

/** Candidate list for the Meeting reassignment UI — every active staff
 * member on the meeting's own team (falling back to the meeting's assigned
 * staff's own team for a pre-existing meeting with no teamId yet, then to
 * every active staff member tenant-wide if no team is resolvable at all —
 * e.g. a manually-created, never-assigned meeting), each tagged with a real
 * free/busy flag at this exact slot. Doubles as the "no staff available ->
 * assign manually" fallback UI: a busy candidate is still listed (not
 * hidden), just marked, so a Supervisor can deliberately override. */
export async function getReassignCandidates(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'assignedStaffId');
  const meeting = await Meeting.findOne(filter).lean();
  if (!meeting) return null;

  let teamId = (meeting as any).teamId as string | undefined;
  if (!teamId && (meeting as any).assignedStaffId) {
    const resolved = await resolveTeamFromStaffId(tenantId, (meeting as any).assignedStaffId);
    teamId = resolved.teamId ?? undefined;
  }

  const staffFilter: Record<string, unknown> = { tenantId: tid, status: 'active' };
  if (teamId && mongoose.isValidObjectId(teamId)) staffFilter.teamId = new mongoose.Types.ObjectId(teamId);
  const roster = await NativeStaff.find(staffFilter).select('staffId firstName lastName').sort({ _id: 1 }).lean();

  const startDate = (meeting as any).startDate;
  const endDate = (meeting as any).endDate;
  const candidates = await Promise.all(roster.map(async (s) => {
    const free = (startDate && endDate)
      ? await isSlotFree(tenantId, new Date(startDate).toISOString(), new Date(endDate).toISOString(), s.staffId, id)
      : true;
    return {
      staffId: s.staffId,
      name: `${s.firstName} ${s.lastName}`.trim(),
      free,
      current: s.staffId === (meeting as any).assignedStaffId,
    };
  }));

  return { teamId: teamId ?? null, candidates };
}

export async function getMeetingStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const matchFilter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToFilter(matchFilter, scope, 'assignedStaffId');
  const [total, byStatus] = await Promise.all([
    Meeting.countDocuments(matchFilter),
    Meeting.aggregate([{ $match: matchFilter }, { $group: { _id: '$meetingStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
