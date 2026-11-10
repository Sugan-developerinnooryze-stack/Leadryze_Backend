import mongoose from 'mongoose';
import { NativeStaff } from './staff.model';
import { excludeDeactivatedLogins } from './bookable-staff';
import { StaffListOptions } from './staff.types';
import { ensureCredentials } from '../shared/app-credentials.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { preparePiiUpdate } from '../shared/pii-update';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

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
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { staffId: id }] }
    : { staffId: id };
  return NativeStaff.findOne({ ...idFilter, tenantId: tid }).populate('teamId', 'name');
}

/** Resolves a staff doc by its business `staffId` string (e.g. "ACME-ST-0002"),
 * not its Mongo `_id` — nothing else in this codebase does this today. Used
 * by the department/doctor booking wizard: the widget carries a staffId
 * string chosen by the visitor, never a raw Mongo id. Only ever returns an
 * ACTIVE staff member — a stale/deleted/inactive selection resolves to
 * `null`, letting the caller fail open to round-robin instead of blocking. */
export async function getActiveStaffByStaffId(tenantId: string, staffId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  // LR-C4-USER-006: a chosen doctor whose linked login is deactivated is not
  // bookable; the booking then falls back to round-robin, as for inactive staff.
  return NativeStaff.findOne(await excludeDeactivatedLogins({ tenantId: tid, staffId, status: 'active' }, tid))
    .select('staffId firstName lastName teamId')
    .lean();
}

export async function createStaff(data: any) {
  const doc = await NativeStaff.create(data);
  // Auto-generate staff-app login credentials — never blocks/breaks creation
  await ensureCredentials(NativeStaff, doc._id, doc.tenantId, data.firstName ?? '');
  indexNativeSearchRecord(String(doc.tenantId), 'native-crm', 'staffs', doc.toObject(), [doc.firstName, doc.lastName].filter(Boolean).join(' '));
  return doc;
}

export async function updateStaff(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  // Same row-level enforcement listStaffs already applies to the list view —
  // without it, a scoped Manager could edit (or reassign onto their own
  // team) a Staff record outside their scope just by knowing its id, even
  // though they'd never see it in their own scoped list in the first place.
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { staffId: id }] }
    : { staffId: id };
  const filter: any = { ...idFilter, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'staffId');
  // findOneAndUpdate skips the pre('save') hook that encrypts PII on create.
  const updated = await NativeStaff.findOneAndUpdate(
    withExpectedVersion(filter, guard),
    preparePiiUpdate(data, 'staffs', NativeStaff),
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativeStaff, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'staffs', updated.toObject(), [updated.firstName, updated.lastName].filter(Boolean).join(' '));
  return updated;
}

export async function deleteStaff(id: string, tenantId: string, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { staffId: id }] }
    : { staffId: id };
  const filter = { ...idFilter, tenantId: tid };
  const deleted = await NativeStaff.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeStaff, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'staffs', String(deleted._id));
  return deleted;
}
