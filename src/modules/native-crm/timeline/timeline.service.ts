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
