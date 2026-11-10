import mongoose from 'mongoose';
import { Company } from './company.model';
import { CreateCompanyDTO, UpdateCompanyDTO } from './company.types';
import { PaginatedResult, ListOptions } from '../native-crm.types';
import { DataScope } from '../../../types';
import { Contact } from '../contacts/contact.model';
import { Deal } from '../deals/deal.model';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

export async function listCompanies(tenantId: string, opts: ListOptions = {}, scope?: DataScope, userId?: string): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20, search, status, ownerTab } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope, 'createdBy', ownerTab, userId);
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

export async function createCompany(tenantId: string, dto: CreateCompanyDTO & { createdBy?: string }) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const created = await Company.create({ tenantId: tid, ...dto });
  indexNativeSearchRecord(tenantId, 'native', 'companies', created.toObject(), created.name);
  return created;
}

export async function updateCompany(tenantId: string, id: string, dto: UpdateCompanyDTO, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const doc = await Company.findOne(filter);
  if (!doc) return null;

  // LR-NEG-001: Detect stale concurrent save (lost update prevention) — version token mandatory
  const clientUpdatedAt = (dto as any).updatedAt ? new Date((dto as any).updatedAt).getTime() : null;
  const clientVersion = (dto as any).__v !== undefined ? Number((dto as any).__v) : ((dto as any).version !== undefined ? Number((dto as any).version) : null);
  if (clientVersion === null && clientUpdatedAt === null) {
    const err: any = new Error('This company was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientVersion !== null && doc.__v !== undefined && doc.__v !== clientVersion) {
    const err: any = new Error('This company was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientUpdatedAt && (doc as any).updatedAt) {
    const docTime = new Date((doc as any).updatedAt).getTime();
    if (docTime - clientUpdatedAt > 500) {
      const err: any = new Error('This company was changed by someone else — please reload and try again.');
      err.name = 'VersionError';
      throw err;
    }
  }

  const { updatedAt: _u, __v: _v, version: _ver, ...cleanDto } = dto as any;
  doc.set(cleanDto);
  await doc.save();
  const updated = doc.toObject();
  indexNativeSearchRecord(tenantId, 'native', 'companies', updated, updated.name);
  return updated;
}

export async function deleteCompany(tenantId: string, id: string, scope?: DataScope, guard?: WriteGuard): Promise<boolean> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const existing = await Company.findOne(filter);
  if (!existing) return false;

  // LR-C4-DEL-002: Check for linked contacts and deals before deleting
  const idStr = String(existing._id);
  const clientId = (existing as any).clientId ? String((existing as any).clientId) : null;
  const matchIds = clientId ? [idStr, clientId] : [idStr];

  const [contacts, deals] = await Promise.all([
    Contact.countDocuments({ tenantId: tid, companyId: { $in: matchIds } }),
    Deal.countDocuments({ tenantId: tid, companyId: { $in: matchIds } }),
  ]);

  const linked: string[] = [];
  if (contacts) linked.push(`${contacts} contact${contacts > 1 ? 's' : ''}`);
  if (deals)    linked.push(`${deals} deal${deals > 1 ? 's' : ''}`);
  if (linked.length) {
    throw Object.assign(
      new Error(`Cannot delete — this company has ${linked.join(', ')}. Remove or reassign them first.`),
      { statusCode: 409 }
    );
  }

  const res = await Company.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!res) await throwIfStale(Company, filter, guard);
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
