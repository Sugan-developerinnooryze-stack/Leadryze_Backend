import mongoose from 'mongoose';
import { NativeStaff } from './staff.model';
import { StaffListOptions } from './staff.types';
import { ensureCredentials } from '../shared/app-credentials.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';

export async function listStaffs(tenantId: string, opts: StaffListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToFilter(filter, scope, 'staffId');

  if (opts.status) filter.status = opts.status;
  if (opts.teamId) filter.teamId = new mongoose.Types.ObjectId(opts.teamId);
  if (opts.search) filter.$or = [
    { firstName: new RegExp(opts.search, 'i') },
    { lastName:  new RegExp(opts.search, 'i') },
    { email:     new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeStaff.find(filter)
      .populate('teamId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    NativeStaff.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getStaffById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeStaff.findOne({ _id: id, tenantId: tid }).populate('teamId', 'name');
}

/** Resolves a staff doc by its business `staffId` string (e.g. "ACME-ST-0002"),
 * not its Mongo `_id` — nothing else in this codebase does this today. Used
 * by the department/doctor booking wizard: the widget carries a staffId
 * string chosen by the visitor, never a raw Mongo id. Only ever returns an
 * ACTIVE staff member — a stale/deleted/inactive selection resolves to
 * `null`, letting the caller fail open to round-robin instead of blocking. */
export async function getActiveStaffByStaffId(tenantId: string, staffId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeStaff.findOne({ tenantId: tid, staffId, status: 'active' })
    .select('staffId firstName lastName teamId')
    .lean();
}

export async function createStaff(data: any) {
  const doc = await NativeStaff.create(data);
  // Auto-generate staff-app login credentials — never blocks/breaks creation
  await ensureCredentials(NativeStaff, doc._id, doc.tenantId, data.firstName ?? '');
  return doc;
}

export async function updateStaff(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeStaff.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteStaff(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeStaff.findOneAndDelete({ _id: id, tenantId: tid });
}
