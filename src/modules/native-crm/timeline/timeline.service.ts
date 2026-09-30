import mongoose from 'mongoose';
import { NativeTimeline } from './timeline.model';

export async function logTimeline(
  tenantId: string | mongoose.Types.ObjectId,
  entityModule: string,
  entityId: string,
  action: string,
  description: string,
  performedBy?: string,
  metadata?: Record<string, any>
) {
  return NativeTimeline.create({ tenantId, entityModule, entityId, action, description, performedBy, metadata });
}

export async function getTimeline(
  tenantId: string,
  entityModule: string,
  entityId: string,
  limit = 50
) {
  return NativeTimeline
    .find({ tenantId: new mongoose.Types.ObjectId(tenantId), entityModule, entityId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/** Tenant-wide activity feed — every other query in this file is scoped to
 * one record; this one spans the whole tenant, restricted to only the
 * entityModule values the caller is allowed to see (resolved by the
 * controller via ENTITY_MODULE_ACCESS before calling this). */
export async function getRecentTenantTimeline(
  tenantId: string,
  allowedModules: string[],
  limit = 10
) {
  if (allowedModules.length === 0) return [];
  return NativeTimeline
    .find({ tenantId: new mongoose.Types.ObjectId(tenantId), entityModule: { $in: allowedModules } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}
