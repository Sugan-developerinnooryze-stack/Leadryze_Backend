import mongoose from 'mongoose';
import { FSSettings } from './fs-settings.model';
import { Tenant } from '../../tenants/tenant.model';

export async function getSettings(tenantId: string, branchId?: string | null) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const bid = branchId ? new mongoose.Types.ObjectId(branchId) : null;

  let settings = await FSSettings.findOne({ tenantId: tid, branchId: bid });
  let isInherited = false;

  // Branch has no settings doc yet → fall back to main org values as display defaults
  if (!settings && branchId) {
    settings = await FSSettings.findOne({ tenantId: tid, branchId: null });
    isInherited = true;
  }

  const tenant = await Tenant.findById(tid).select('clientId').lean();
  const base = settings ? settings.toObject() : {};
  // Strip _id/branchId/__v so a subsequent save creates a new branch-specific doc
  const { _id, branchId: _bid, __v, ...rest } = base as any;
  return { ...rest, clientId: tenant?.clientId ?? null, isInherited };
}

export async function upsertSettings(tenantId: string, data: any, branchId?: string | null) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const { tenantId: _t, branchId: _b, ...safeData } = data;
  const filter: any = { tenantId: tid, branchId: branchId ? new mongoose.Types.ObjectId(branchId) : null };
  return FSSettings.findOneAndUpdate(
    filter,
    { $set: safeData },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

export async function nextClientId(tenantId: string): Promise<string> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const settings = await FSSettings.findOneAndUpdate(
    { tenantId: tid, branchId: null },
    { $inc: { lastClientNumId: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const prefix = settings.autoClientIdPrefix ?? 'LRZ';
  return `${prefix}-${settings.lastClientNumId}`;
}
