import mongoose from 'mongoose';
import { Lead } from './lead.model';
import { LeadListOptions } from './lead.types';

export async function listLeads(tenantId: string, opts: LeadListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 50);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status)     filter.status   = opts.status;
  if (opts.source)     filter.source   = opts.source;
  if (opts.rating)     filter.rating   = opts.rating;
  if (opts.priority)   filter.priority = opts.priority;
  if (opts.leadOwner)  filter.leadOwner = opts.leadOwner;
  if (opts.isConverted !== undefined)
    filter.isConverted = opts.isConverted === 'true';

  if (opts.search) {
    const re = new RegExp(opts.search, 'i');
    filter.$or = [
      { firstName: re }, { lastName: re },
      { company: re }, { email: re }, { phone: re }, { leadId: re },
    ];
  }

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .sort({ lastActivityAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getLeadById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Lead.findOne({ $or: [{ _id: mongoose.isValidObjectId(id) ? id : null }, { leadId: id }], tenantId: tid });
}

export async function createLead(data: any) {
  return Lead.create(data);
}

export async function updateLead(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Lead.findOneAndUpdate(
    { _id: id, tenantId: tid },
    { ...data, lastActivityAt: new Date() },
    { new: true, runValidators: true }
  );
}

export async function updateLeadStage(id: string, tenantId: string, status: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Lead.findOneAndUpdate(
    { _id: id, tenantId: tid },
    { status, lastActivityAt: new Date() },
    { new: true }
  );
}

export async function deleteLead(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Lead.findOneAndDelete({ _id: id, tenantId: tid });
}

export async function getLeadRaw(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Lead.findOne({ _id: id, tenantId: tid });
}
