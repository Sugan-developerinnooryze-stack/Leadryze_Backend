import mongoose from 'mongoose';
import { NativeQuotation } from './quotation.model';
import { QuotationListOptions } from './quotation.types';

export async function listQuotations(tenantId: string, opts: QuotationListOptions, branchId?: string | null) {
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

  const [items, total] = await Promise.all([
    NativeQuotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeQuotation.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getQuotationById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeQuotation.findOne({ _id: id, tenantId: tid });
}

export async function createQuotation(data: any) {
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(data.discount ?? 0);
  const gst      = Number(data.gstPercentage ?? 0);
  const after    = svcTotal + prtTotal - discount;
  return NativeQuotation.create({
    ...data,
    partsAmount:           prtTotal,
    servicesAmount:        after,
    servicesAmountWithTax: after + (after * gst) / 100,
  });
}

export async function updateQuotation(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeQuotation.findOne({ _id: id, tenantId: tid }).lean();
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
  return NativeQuotation.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteQuotation(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeQuotation.findOneAndDelete({ _id: id, tenantId: tid });
}
