import mongoose from 'mongoose';
import { Branch } from './branch.model';
import { Tenant } from '../../tenants/tenant.model';

const PLAN_LIMITS: Record<string, number> = {
  starter:      2,
  professional: 10,
  enterprise:   Infinity,
};

function toObjectId(id: string) {
  return new mongoose.Types.ObjectId(id);
}

export async function listBranches(tenantId: string, includeInactive = false) {
  const filter: any = { tenantId: toObjectId(tenantId) };
  if (!includeInactive) filter.status = 'active';
  return Branch.find(filter).sort({ branchName: 1 }).lean();
}

export async function getBranchById(id: string, tenantId: string) {
  return Branch.findOne({ _id: toObjectId(id), tenantId: toObjectId(tenantId) });
}

export async function createBranch(tenantId: string, data: any) {
  const tid = toObjectId(tenantId);

  const tenant = await Tenant.findById(tid).select('plan').lean();
  if (!tenant) throw new Error('Tenant not found');

  const limit = PLAN_LIMITS[tenant.plan] ?? 2;
  const count = await Branch.countDocuments({ tenantId: tid, status: 'active' });
  if (count >= limit) {
    throw new Error(`Branch limit reached for your ${tenant.plan} plan (max ${limit === Infinity ? 'unlimited' : limit})`);
  }

  // Auto-generate branchCode from city or name
  const base = (data.city || data.branchName || 'BR').toUpperCase().replace(/\s+/g, '').slice(0, 3);
  const existing = await Branch.countDocuments({ tenantId: tid });
  const branchCode = `${base}-${String(existing + 1).padStart(3, '0')}`;

  return Branch.create({ ...data, tenantId: tid, branchCode });
}

export async function updateBranch(id: string, tenantId: string, data: any) {
  const tid = toObjectId(tenantId);
  return Branch.findOneAndUpdate(
    { _id: toObjectId(id), tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deactivateBranch(id: string, tenantId: string) {
  const tid = toObjectId(tenantId);
  return Branch.findOneAndUpdate(
    { _id: toObjectId(id), tenantId: tid },
    { status: 'inactive' },
    { new: true }
  );
}

export async function getBranchLimitInfo(tenantId: string) {
  const tid = toObjectId(tenantId);
  const tenant = await Tenant.findById(tid).select('plan').lean();
  const plan = tenant?.plan ?? 'starter';
  const limit = PLAN_LIMITS[plan] ?? 2;
  const used  = await Branch.countDocuments({ tenantId: tid, status: 'active' });
  return { plan, used, limit: limit === Infinity ? null : limit };
}
