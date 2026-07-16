import mongoose from 'mongoose';
import { Activity, IActivity } from './activity.model';

export type ActivityType = IActivity['type'];
export type ActivityStatus = IActivity['status'];

export interface CreateActivityDto {
  type:        ActivityType;
  customType?: string;
  category?:   string;
  subcategory?:string;
  title:       string;
  status?:     ActivityStatus;
  priority?:   IActivity['priority'];
  startDate?:  string | Date;
  endDate?:    string | Date;
  dueDate?:    string | Date;
  allDay?:     boolean;
  color?:      string;
  location?:   string;
  notes?:      string;
  tags?:       string[];
  linkedPerson?: IActivity['linkedPerson'];
  fields?:     Record<string, unknown>;
  createdBy?:  string;
}

export interface ListActivityFilters {
  type?:   ActivityType;
  status?: ActivityStatus;
  page:    number;
  limit:   number;
}

export async function createActivity(tenantId: string, dto: CreateActivityDto) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const activity = await Activity.create({
    tenantId: tid,
    ...dto,
    startDate: dto.startDate ? new Date(dto.startDate) : undefined,
    endDate:   dto.endDate   ? new Date(dto.endDate)   : undefined,
    dueDate:   dto.dueDate   ? new Date(dto.dueDate)   : undefined,
    fields:    dto.fields || {},
  });
  return activity.toObject();
}

export async function listActivities(tenantId: string, filters: ListActivityFilters) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const query: Record<string, unknown> = { tenantId: tid };
  if (filters.type)   query.type   = filters.type;
  if (filters.status) query.status = filters.status;

  const skip  = (filters.page - 1) * filters.limit;
  const [items, total] = await Promise.all([
    Activity.find(query).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
    Activity.countDocuments(query),
  ]);
  return { items, total, page: filters.page, limit: filters.limit, pages: Math.ceil(total / filters.limit) };
}

export async function getActivity(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Activity.findOne({ _id: id, tenantId: tid }).lean();
}

export async function updateActivity(tenantId: string, id: string, dto: Partial<CreateActivityDto>) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const update: Record<string, unknown> = { ...dto };
  if (dto.startDate) update.startDate = new Date(dto.startDate);
  if (dto.endDate)   update.endDate   = new Date(dto.endDate);
  if (dto.dueDate)   update.dueDate   = new Date(dto.dueDate);
  return Activity.findOneAndUpdate(
    { _id: id, tenantId: tid },
    { $set: update },
    { new: true }
  ).lean();
}

export async function deleteActivity(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const result = await Activity.deleteOne({ _id: id, tenantId: tid });
  return result.deletedCount > 0;
}

export async function getActivityStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [byType, byStatus] = await Promise.all([
    Activity.aggregate([
      { $match: { tenantId: tid } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
    Activity.aggregate([
      { $match: { tenantId: tid } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const typeMap: Record<string, number> = {};
  byType.forEach((t: { _id: string; count: number }) => { typeMap[t._id] = t.count; });

  const statusMap: Record<string, number> = {};
  byStatus.forEach((s: { _id: string; count: number }) => { statusMap[s._id] = s.count; });

  const total = Object.values(typeMap).reduce((a, b) => a + b, 0);
  return {
    total,
    byType:    typeMap,
    pending:   statusMap['pending']     || 0,
    inProgress:statusMap['in_progress'] || 0,
    completed: statusMap['completed']   || 0,
    cancelled: statusMap['cancelled']   || 0,
  };
}
