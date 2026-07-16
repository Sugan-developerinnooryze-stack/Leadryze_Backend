import mongoose from 'mongoose';
import { Company } from './company.model';
import { CreateCompanyDTO, UpdateCompanyDTO } from './company.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';

export async function listCompanies(tenantId: string, opts: ListOptions = {}): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (status) filter.companyStatus = status;
  if (search) {
    const re = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ name: re }, { domain: re }, { city: re }, { industry: re }];
  }
  const [items, total] = await Promise.all([
    Company.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Company.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getCompanyById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Company.findOne({ _id: id, tenantId: tid }).lean();
}

export async function createCompany(tenantId: string, dto: CreateCompanyDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Company.create({ tenantId: tid, ...dto });
}

export async function updateCompany(tenantId: string, id: string, dto: UpdateCompanyDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Company.findOneAndUpdate({ _id: id, tenantId: tid }, { $set: dto }, { new: true }).lean();
}

export async function deleteCompany(tenantId: string, id: string): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const res = await Company.findOneAndDelete({ _id: id, tenantId: tid });
  return !!res;
}

export async function getCompanyStats(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const [total, byStatus] = await Promise.all([
    Company.countDocuments({ tenantId: tid }),
    Company.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: '$companyStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
