import mongoose from 'mongoose';
import { Company } from './company.model';
import { CreateCompanyDTO, UpdateCompanyDTO } from './company.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listCompanies(tenantId: string, opts: ListOptions = {}, scope?: DataScope): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
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

export async function getCompanyById(tenantId: string, id: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return Company.findOne(filter).lean();
}

export async function createCompany(tenantId: string, dto: CreateCompanyDTO) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Company.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'companies', created.toObject(), created.name);
  return created;
}

export async function updateCompany(tenantId: string, id: string, dto: UpdateCompanyDTO, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await Company.findOneAndUpdate(filter, { $set: dto }, { new: true }).lean();
  if (updated) indexNativeSearchRecord(tenantId, 'native', 'companies', updated, updated.name);
  return updated;
}

export async function deleteCompany(tenantId: string, id: string, scope?: DataScope): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const res = await Company.findOneAndDelete(filter);
  if (res) removeNativeSearchRecord(tenantId, 'native', 'companies', String(res._id));
  return !!res;
}

export async function getCompanyStats(tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const [total, byStatus] = await Promise.all([
    Company.countDocuments(filter),
    Company.aggregate([{ $match: filter }, { $group: { _id: '$companyStatus', count: { $sum: 1 } } }]),
  ]);
  return { total, byStatus: Object.fromEntries(byStatus.map((r) => [r._id as string, r.count as number])) };
}
