import mongoose from 'mongoose';
import { NativeRecord } from './native-record.model';
import { NativeModule, NATIVE_MODULES, MODULE_CONFIGS } from './native-crm.config';

/* ── List ──────────────────────────────────────────────────────────────────── */
export async function listRecords(
  tenantId: string,
  module: NativeModule,
  opts: { page?: number; limit?: number; search?: string; status?: string }
) {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid, module };
  if (status) filter.status = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ displayName: re }];
  }
  const [items, total] = await Promise.all([
    NativeRecord.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    NativeRecord.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

/* ── Get one ───────────────────────────────────────────────────────────────── */
export async function getRecord(tenantId: string, module: NativeModule, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeRecord.findOne({ _id: id, tenantId: tid, module }).lean();
}

/* ── Create ────────────────────────────────────────────────────────────────── */
export async function createRecord(tenantId: string, module: NativeModule, dto: Record<string, unknown>) {
  const tid    = new mongoose.Types.ObjectId(tenantId);
  const config = MODULE_CONFIGS[module];
  const displayName = config.displayNameFn(dto as Record<string, unknown>);
  const statusField = config.statusField;
  const status = statusField && dto[statusField] ? String(dto[statusField]) : config.defaultStatus;

  return NativeRecord.create({ tenantId: tid, module, displayName, status, fields: dto });
}

/* ── Update ────────────────────────────────────────────────────────────────── */
export async function updateRecord(tenantId: string, module: NativeModule, id: string, dto: Record<string, unknown>) {
  const tid    = new mongoose.Types.ObjectId(tenantId);
  const config = MODULE_CONFIGS[module];

  // Merge with existing fields
  const existing = await NativeRecord.findOne({ _id: id, tenantId: tid, module }).lean();
  if (!existing) return null;

  const mergedFields = { ...((existing.fields as Record<string, unknown>) || {}), ...dto };
  const displayName  = config.displayNameFn(mergedFields);
  const statusField  = config.statusField;
  const status = statusField && mergedFields[statusField] ? String(mergedFields[statusField]) : existing.status;

  return NativeRecord.findOneAndUpdate(
    { _id: id, tenantId: tid, module },
    { $set: { fields: mergedFields, displayName, status } },
    { new: true }
  ).lean();
}

/* ── Delete ────────────────────────────────────────────────────────────────── */
export async function deleteRecord(tenantId: string, module: NativeModule, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await NativeRecord.findOneAndDelete({ _id: id, tenantId: tid, module });
  return !!res;
}

/* ── Module counts (for sidebar) ──────────────────────────────────────────── */
export async function getModuleCounts(tenantId: string): Promise<Record<string, number>> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const rows = await NativeRecord.aggregate([
    { $match: { tenantId: tid } },
    { $group: { _id: '$module', count: { $sum: 1 } } },
  ]);
  const result: Record<string, number> = {};
  for (const m of NATIVE_MODULES) result[m] = 0;
  for (const r of rows) result[r._id as string] = r.count as number;
  return result;
}
