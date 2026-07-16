import mongoose from 'mongoose';
import { NativeStaff } from './staff.model';
import { StaffListOptions } from './staff.types';
import { ensureCredentials } from '../shared/app-credentials.service';

export async function listStaffs(tenantId: string, opts: StaffListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

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
