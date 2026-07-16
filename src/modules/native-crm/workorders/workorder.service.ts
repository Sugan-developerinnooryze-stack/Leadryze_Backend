import mongoose from 'mongoose';
import { NativeWorkorder } from './workorder.model';
import { WorkorderListOptions } from './workorder.types';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeContract }  from '../contracts/contract.model';
import { NativeStaff }     from '../staffs/staff.model';
import { getSettings }     from '../fs-settings/fs-settings.service';

/** Tenant's default workorder duration from FS Settings (hours), or null. */
async function getDefaultDuration(tenantId: string, branchId?: string | null): Promise<number | null> {
  const settings: any = await getSettings(tenantId, branchId ?? null).catch(() => null);
  const def = Number(settings?.defaultDurationHours);
  return Number.isFinite(def) && def > 0 ? def : null;
}

export async function listWorkorders(tenantId: string, opts: WorkorderListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:      new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];
  if (opts.customerId) filter.customerId = opts.customerId;
  if (opts.contractId) filter.contractId = opts.contractId;
  if (opts.staffId) {
    const staffOr = [{ staffId: opts.staffId }, { staffIds: opts.staffId }];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: staffOr }];
      delete filter.$or;
    } else {
      filter.$or = staffOr;
    }
  }

  const [items, total] = await Promise.all([
    NativeWorkorder.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeWorkorder.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getWorkorderById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeWorkorder.findOne({ _id: id, tenantId: tid });
}

/** Keep staffId <-> staffIds consistent when either key is present in the payload. */
function normalizeStaffAssignment(data: any) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.staffIds)) {
    data.staffId = data.staffIds[0] ?? null;
  } else if (typeof data.staffId === 'string' && data.staffIds === undefined) {
    data.staffIds = data.staffId ? [data.staffId] : [];
  }
  return data;
}

/** Link a WO back to its contract visit (fire-and-forget, never blocks). */
function syncContractVisit(
  tenantId: unknown,
  contractId: string,
  visitNumber: number,
  set: Record<string, unknown>,
) {
  NativeContract.findOneAndUpdate(
    { tenantId, contractId, visits: { $elemMatch: { visitNumber } } },
    { $set: set },
  ).catch(() => {});
}

export async function createWorkorder(data: any) {
  // Duration is managed centrally: default from FS Settings when not provided
  if (data.durationHours == null || Number(data.durationHours) <= 0) {
    const def = await getDefaultDuration(String(data.tenantId), data.branchId ? String(data.branchId) : null);
    if (def) data.durationHours = def;
  }
  const doc = await NativeWorkorder.create(normalizeStaffAssignment(data));

  // Contract master engine: mark the source visit as scheduled + link this WO
  if (data.contractId && data.contractVisitNumber) {
    syncContractVisit(doc.tenantId, data.contractId, Number(data.contractVisitNumber), {
      'visits.$.status':      'scheduled',
      'visits.$.workOrderId': (doc as any).workOrderId,
      'visits.$.woId':        String(doc._id),
    });
  }
  if (data.createdBy !== 'system') {
    const mongoId = (doc._id as any).toString();
    if (data.quotationId) {
      const src = await NativeQuotation.findOne({ quotationId: data.quotationId }).select('_id').lean();
      if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'workorder', mongoId }).catch(() => {});
    } else if (data.contractId) {
      const src = await NativeContract.findOne({ contractId: data.contractId }).select('_id').lean();
      if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'workorder', mongoId }).catch(() => {});
    }
  }
  return doc;
}

export async function updateWorkorder(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const doc = await NativeWorkorder.findOneAndUpdate(
    { _id: id, tenantId: tid },
    normalizeStaffAssignment(data),
    { new: true, runValidators: true }
  );

  // Contract master engine: keep the linked visit's status in sync
  const wo: any = doc;
  if (wo?.contractId && wo?.contractVisitNumber && data.status) {
    if (data.status === 'completed') {
      syncContractVisit(wo.tenantId, wo.contractId, Number(wo.contractVisitNumber), {
        'visits.$.status': 'completed',
      });
    } else if (data.status === 'cancelled') {
      syncContractVisit(wo.tenantId, wo.contractId, Number(wo.contractVisitNumber), {
        'visits.$.status':      'planned',
        'visits.$.workOrderId': '',
        'visits.$.woId':        '',
      });
    }
  }
  return doc;
}

export async function deleteWorkorder(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeWorkorder.findOneAndDelete({ _id: id, tenantId: tid });
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function findNearestStaff(
  tenantId: string,
  params: { lat: number; lng: number; skills?: string[]; date?: string; limit?: number }
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { tenantId: tid, status: 'active', 'location.lat': { $exists: true } };
  if (params.skills?.length) filter.skills = { $all: params.skills };

  const staffList = await NativeStaff.find(filter).lean();

  const results = await Promise.all(
    staffList.map(async (staff) => {
      const distance_km = haversineKm(
        params.lat, params.lng,
        staff.location!.lat, staff.location!.lng
      );
      let busy = false;
      if (params.date) {
        const avail = await checkStaffAvailability(tenantId, staff.staffId, params.date);
        busy = avail.busy;
      }
      return {
        staffId:   staff.staffId,
        _id:       staff._id,
        fullName:  `${staff.firstName} ${staff.lastName}`,
        distance_km: Math.round(distance_km * 10) / 10,
        busy,
        skills:    staff.skills ?? [],
        location:  staff.location,
      };
    })
  );

  results.sort((a, b) => a.distance_km - b.distance_km);
  return results.slice(0, params.limit ?? 10);
}

/** True when a stored date carries no time component (date-only legacy value). */
function isDateOnly(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export async function checkStaffAvailability(
  tenantId: string,
  staffId: string,
  date: string,
  opts?: { datetime?: string; duration?: number; excludeId?: string },
) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const requestTime = opts?.datetime ? new Date(opts.datetime) : null;
  const hasTime     = !!requestTime && !isNaN(requestTime.getTime());

  // Widen the query window ±24h so duration buffers crossing midnight are caught
  const queryStart = new Date(dayStart.getTime() - 24 * 3600 * 1000);
  const queryEnd   = new Date(dayEnd.getTime()   + 24 * 3600 * 1000);

  const filter: any = {
    tenantId: tid,
    $or: [{ staffId }, { staffIds: staffId }],
    scheduledDate: { $gte: queryStart, $lte: queryEnd },
    status: { $nin: ['cancelled'] },
  };
  if (opts?.excludeId && mongoose.Types.ObjectId.isValid(opts.excludeId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(opts.excludeId) };
  }

  const candidates = await NativeWorkorder.find(filter)
    .select('workOrderId title scheduledDate status durationHours')
    .lean();

  // Fallback duration for workorders saved without one (duration is managed
  // centrally in FS Settings — the form no longer sends it)
  const defaultD = await getDefaultDuration(tenantId);

  const target = new Date(date);
  let conflict: any = null;
  let allDay = false;
  let availableAfter:  Date | null = null;  // staff is free again from this time
  let availableBefore: Date | null = null;  // staff is also free before this time

  for (const wo of candidates) {
    const S = new Date((wo as any).scheduledDate);
    const stored = (wo as any).durationHours as number | undefined;
    const D = stored && stored > 0 ? stored : defaultD;
    const legacy = !D || isDateOnly(S);

    if (!hasTime || legacy) {
      // Legacy behavior: any workorder on the same calendar day blocks the whole day
      if (sameCalendarDay(S, target)) {
        conflict = wo;
        allDay   = true;
        const nextDay = new Date(target);
        nextDay.setHours(0, 0, 0, 0);
        nextDay.setDate(nextDay.getDate() + 1);
        availableAfter = nextDay;
        break;
      }
    } else {
      // Time-window: occupied [S, S+D]; blocked window adds a duration-sized
      // buffer before and after → [S−D, S+2D]. The new WO's START time must be
      // outside the blocked window — before it or after it, same-day is fine.
      const blockedStart = S.getTime() - D * 3600 * 1000;
      const blockedEnd   = S.getTime() + 2 * D * 3600 * 1000;
      const newStart     = requestTime!.getTime();
      if (newStart >= blockedStart && newStart < blockedEnd) {
        conflict = wo;
        availableAfter  = new Date(blockedEnd);
        availableBefore = new Date(blockedStart);
        break;
      }
    }
  }

  return {
    busy: !!conflict,
    allDay,
    availableAfter:  availableAfter  ? availableAfter.toISOString()  : null,
    availableBefore: availableBefore ? availableBefore.toISOString() : null,
    conflictingWorkOrder: conflict
      ? {
          workOrderId:   conflict.workOrderId,
          title:         conflict.title,
          scheduledDate: conflict.scheduledDate,
          status:        conflict.status,
          durationHours: conflict.durationHours,
        }
      : undefined,
  };
}
