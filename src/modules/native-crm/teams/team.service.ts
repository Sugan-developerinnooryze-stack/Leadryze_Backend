import mongoose from 'mongoose';
import { NativeTeam } from './team.model';
import { TeamListOptions } from './team.types';
import { DataScope } from '../../../types';
import { applyDataScopeToTeamFilter } from '../shared/data-scope';

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

export async function createTeam(data: any) {
  return NativeTeam.create(data);
}

export async function updateTeam(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeTeam.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteTeam(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeTeam.findOneAndDelete({ _id: id, tenantId: tid });
}
