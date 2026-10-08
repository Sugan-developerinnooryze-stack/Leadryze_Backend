import mongoose from 'mongoose';
import { FSSettings } from './fs-settings.model';
import { Tenant } from '../../tenants/tenant.model';
import { Branch } from '../branches/branch.model';

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

/** One entry per active Company (Branch) plus a `branchId: null` entry for
 * "Default Company" — just the two fields a transactional form's "Company"
 * dropdown needs to auto-fill Discount %/GST % the instant it's selected
 * (see FSDrawer.tsx's autofillFrom mechanism). A company with no FSSettings
 * doc of its own yet inherits the org-wide (branchId: null) values, same
 * "inherit until explicitly overridden" rule getSettings() already applies
 * for the full settings object. Fetched once, up front, alongside the other
 * lookup lists (customers/sites/teams/etc.) — no per-selection request. */
export async function getAllSettingsDefaults(tenantId: string): Promise<Array<{
  branchId: string | null; taxPercentage: number; discountPercentage: number;
}>> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [orgDefault, branchDocs, branches] = await Promise.all([
    FSSettings.findOne({ tenantId: tid, branchId: null }).select('taxPercentage discountPercentage').lean(),
    FSSettings.find({ tenantId: tid, branchId: { $ne: null } }).select('branchId taxPercentage discountPercentage').lean(),
    Branch.find({ tenantId: tid, status: 'active' }).select('_id').lean(),
  ]);
  const orgTax      = orgDefault?.taxPercentage ?? 0;
  const orgDiscount = orgDefault?.discountPercentage ?? 0;
  const byBranch = new Map(branchDocs.map((d) => [d.branchId!.toString(), d]));

  const results: Array<{ branchId: string | null; taxPercentage: number; discountPercentage: number }> = [
    { branchId: null, taxPercentage: orgTax, discountPercentage: orgDiscount },
  ];
  for (const b of branches) {
    const doc = byBranch.get(b._id.toString());
    results.push({
      branchId: b._id.toString(),
      taxPercentage: doc?.taxPercentage ?? orgTax,
      discountPercentage: doc?.discountPercentage ?? orgDiscount,
    });
  }
  return results;
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
