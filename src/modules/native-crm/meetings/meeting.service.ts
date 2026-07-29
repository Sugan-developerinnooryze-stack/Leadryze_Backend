import mongoose from 'mongoose';
import { Meeting } from './meeting.model';
import { CreateMeetingDTO, UpdateMeetingDTO } from './meeting.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { sendOnCreateConfirmation } from '../../notifications/confirmation.service';

export async function listMeetings(tenantId: string, opts: ListOptions = {}): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, relatedModule, relatedId, upcoming } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (status) filter.meetingStatus = status;
  if (relatedModule && relatedId) { filter.relatedModule = relatedModule; filter.relatedId = relatedId; }
  if (upcoming) filter.startDate = { $gte: new Date() };
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ title: re }, { location: re }, { notes: re }];
  }
  const [items, total] = await Promise.all([
    Meeting.find(filter).sort({ startDate: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Meeting.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getMeetingById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Meeting.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createMeeting(tenantId: string, dto: CreateMeetingDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Meeting.create({ tenantId: tid, ...dto });
  void sendOnCreateConfirmation(tenantId, 'meeting', created.toObject()); // fire-and-forget, never throws
  return created;
}

export async function updateMeeting(tenantId: string, id: string, dto: UpdateMeetingDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Meeting.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteMeeting(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Meeting.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getMeetingStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [total, byStatus] = await Promise.all([
    Meeting.countDocuments({ tenantId: tid }),
    Meeting.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$meetingStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
