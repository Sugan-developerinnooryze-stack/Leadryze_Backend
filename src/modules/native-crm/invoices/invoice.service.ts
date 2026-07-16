import mongoose from 'mongoose';
import { NativeInvoice } from './invoice.model';
import { InvoiceListOptions } from './invoice.types';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeContract }  from '../contracts/contract.model';

export async function listInvoices(tenantId: string, opts: InvoiceListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { invoiceId:  new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeInvoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeInvoice.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getInvoiceById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeInvoice.findOne({ _id: id, tenantId: tid });
}

export async function createInvoice(data: any) {
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(data.discount ?? 0);
  const gst      = Number(data.gstPercentage ?? 0);
  const after    = svcTotal + prtTotal - discount;
  const doc = await NativeInvoice.create({
    ...data,
    partsAmount:           prtTotal,
    servicesAmount:        after,
    servicesAmountWithTax: after + (after * gst) / 100,
  });
  const mongoId = (doc._id as any).toString();
  if (data.workOrderId) {
    const src = await NativeWorkorder.findOne({ workOrderId: data.workOrderId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'workorder', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  } else if (data.quotationId) {
    const src = await NativeQuotation.findOne({ quotationId: data.quotationId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'quotation', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  } else if (data.contractId) {
    const src = await NativeContract.findOne({ contractId: data.contractId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'invoice', mongoId }).catch(() => {});
  }
  return doc;
}

export async function updateInvoice(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeInvoice.findOne({ _id: id, tenantId: tid }).lean();
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
  return NativeInvoice.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteInvoice(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeInvoice.findOneAndDelete({ _id: id, tenantId: tid });
}
