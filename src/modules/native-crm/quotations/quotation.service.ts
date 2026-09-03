import mongoose from 'mongoose';
import { NativeQuotation } from './quotation.model';
import { QuotationListOptions } from './quotation.types';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'quotation', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Quotation pipeline`);
  }
}

export async function listQuotations(tenantId: string, opts: QuotationListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:      new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeQuotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeQuotation.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getQuotationById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeQuotation.findOne(filter);
}

export async function createQuotation(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(data.discount ?? 0);
  const gst      = Number(data.gstPercentage ?? 0);
  const after    = svcTotal + prtTotal - discount;
  const created = await NativeQuotation.create({
    ...data,
    partsAmount:           prtTotal,
    servicesAmount:        after,
    servicesAmountWithTax: after + (after * gst) / 100,
  });
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'quotations', created.toObject(), created.title);
  return created;
}

export async function updateQuotation(id: string, tenantId: string, data: any, scope?: DataScope) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeQuotation.findOne(filter).lean();
    const services  = data.services        ?? (existing as any)?.services        ?? [];
    const parts     = data.parts           ?? (existing as any)?.parts           ?? [];
    const discount  = Number(data.discount      ?? (existing as any)?.discount      ?? 0);
    const gst       = Number(data.gstPercentage ?? (existing as any)?.gstPercentage ?? 0);
    const svcTotal  = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
    const prtTotal  = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
    const after     = svcTotal + prtTotal - discount;
    data.partsAmount           = prtTotal;
    data.servicesAmount        = after;
    data.servicesAmountWithTax = after + (after * gst) / 100;
  }
  const updated = await NativeQuotation.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'quotations', updated.toObject(), updated.title);
  return updated;
}

export async function deleteQuotation(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeQuotation.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'quotations', String(deleted._id));
  return deleted;
}
