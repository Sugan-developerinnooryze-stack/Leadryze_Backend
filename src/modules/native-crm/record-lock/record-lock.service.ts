import mongoose from 'mongoose';
import { LockAudit } from './lock-audit.model';
import { FSSettings } from '../fs-settings/fs-settings.model';
import { logTimeline } from '../timeline/timeline.service';

// Lazy imports via getter to avoid circular dependency issues
function getModels(): Record<string, mongoose.Model<any>> {
  const { Lead }            = require('../leads/lead.model');
  const { NativeCustomer }  = require('../customers/customer.model');
  const { Contact }         = require('../contacts/contact.model');
  const { Deal }            = require('../deals/deal.model');
  const { NativeInvoice }   = require('../invoices/invoice.model');
  const { NativeContract }  = require('../contracts/contract.model');
  const { NativeQuotation } = require('../quotations/quotation.model');
  const { NativeWorkorder } = require('../workorders/workorder.model');
  return {
    leads:      Lead,
    customers:  NativeCustomer,
    contacts:   Contact,
    deals:      Deal,
    invoices:   NativeInvoice,
    contracts:  NativeContract,
    quotations: NativeQuotation,
    workorders: NativeWorkorder,
  };
}

function getModel(entityModule: string): mongoose.Model<any> {
  const models = getModels();
  const model = models[entityModule];
  if (!model) throw new Error(`Unknown entityModule: ${entityModule}`);
  return model;
}

function toObjectId(id: string | mongoose.Types.ObjectId) {
  return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;
}

export async function getLockStatus(
  tenantId: string,
  entityModule: string,
  entityId: string,
): Promise<{ isLocked: boolean; lockedAt?: Date; lockedBy?: string; lockReason?: string }> {
  const model = getModel(entityModule);
  const doc = await model.findOne({
    _id:      new mongoose.Types.ObjectId(entityId),
    tenantId: toObjectId(tenantId),
  }).select('isLocked lockedAt lockedBy lockReason').lean() as any;

  return {
    isLocked:   doc?.isLocked ?? false,
    lockedAt:   doc?.lockedAt,
    lockedBy:   doc?.lockedBy,
    lockReason: doc?.lockReason,
  };
}

export async function lockRecord(
  tenantId:    string | mongoose.Types.ObjectId,
  entityModule: string,
  entityId:    string,
  performedBy: string,
  reason:      string,
): Promise<void> {
  const model = getModel(entityModule);
  const tid   = toObjectId(tenantId.toString());

  const doc = await model.findOne({
    _id: new mongoose.Types.ObjectId(entityId), tenantId: tid,
  }).select('isLocked').lean() as any;
  if (!doc) throw new Error('Record not found');
  if (doc.isLocked) throw new Error('Record is already locked');

  const now = new Date();
  await model.updateOne(
    { _id: new mongoose.Types.ObjectId(entityId), tenantId: tid },
    { $set: { isLocked: true, lockedAt: now, lockedBy: performedBy, lockReason: reason } },
  );

  await LockAudit.create({
    tenantId:    tid,
    entityModule,
    entityId,
    action:      'locked',
    reason,
    performedBy,
    performedAt: now,
  });

  logTimeline(
    tid, entityModule, entityId, 'locked',
    `Record locked: ${reason}`, performedBy,
    { reason },
  ).catch(() => {});
}

export async function unlockRecord(
  tenantId:    string | mongoose.Types.ObjectId,
  entityModule: string,
  entityId:    string,
  performedBy: string,
  reason:      string,
): Promise<void> {
  const model = getModel(entityModule);
  const tid   = toObjectId(tenantId.toString());

  const doc = await model.findOne({
    _id: new mongoose.Types.ObjectId(entityId), tenantId: tid,
  }).select('isLocked').lean() as any;
  if (!doc) throw new Error('Record not found');
  if (!doc.isLocked) throw new Error('Record is not locked');

  const now = new Date();
  await model.updateOne(
    { _id: new mongoose.Types.ObjectId(entityId), tenantId: tid },
    { $set: { isLocked: false }, $unset: { lockedAt: 1, lockedBy: 1, lockReason: 1 } },
  );

  await LockAudit.create({
    tenantId:    tid,
    entityModule,
    entityId,
    action:      'unlocked',
    reason,
    performedBy,
    performedAt: now,
  });

  logTimeline(
    tid, entityModule, entityId, 'unlocked',
    `Record unlocked: ${reason}`, performedBy,
    { reason },
  ).catch(() => {});
}

export async function getLockAudit(
  tenantId:    string,
  entityModule: string,
  entityId:    string,
): Promise<ILockAuditDoc[]> {
  return LockAudit.find({
    tenantId:    toObjectId(tenantId),
    entityModule,
    entityId,
  }).sort({ performedAt: -1 }).lean() as any;
}

export async function getTenantLockAudit(
  tenantId: string,
  filters?: { module?: string; page?: number; limit?: number },
) {
  const tid   = toObjectId(tenantId);
  const page  = filters?.page  ?? 1;
  const limit = Math.min(filters?.limit ?? 20, 100);
  const query: any = { tenantId: tid };
  if (filters?.module) query.entityModule = filters.module;

  const [items, total] = await Promise.all([
    LockAudit.find(query).sort({ performedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    LockAudit.countDocuments(query),
  ]);
  return { items, total, page };
}

// Called from controllers after a milestone status change — checks FS Settings config
export async function autoLockIfConfigured(
  tenantId:    string,
  entityModule: string,
  entityId:    string,
  reachedStatus: string,
  performedBy: string,
): Promise<void> {
  const tid = toObjectId(tenantId);
  const settings = await FSSettings.findOne({ tenantId: tid })
    .select('lockingConfig').lean();
  const rule = (settings?.lockingConfig as any[] | undefined)?.find(
    (r: any) => r.module === entityModule && r.autoLock && r.autoLockOnStatus === reachedStatus,
  );
  if (!rule) return;

  try {
    await lockRecord(tenantId, entityModule, entityId, 'system',
      `Auto-locked: ${entityModule} reached status "${reachedStatus}"`);
  } catch {
    // Already locked — ignore
  }
}

import type { ILockAuditDoc } from './lock-audit.model';
