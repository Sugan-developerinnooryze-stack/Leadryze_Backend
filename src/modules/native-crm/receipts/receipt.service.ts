import mongoose from 'mongoose';
import { NativeReceipt } from './receipt.model';
import { ReceiptListOptions } from './receipt.types';

export async function listReceipts(tenantId: string, opts: ReceiptListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { receiptId:  new RegExp(opts.search, 'i') },
    { invoiceId:  new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeReceipt.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeReceipt.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getReceiptById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeReceipt.findOne({ _id: id, tenantId: tid });
}

export async function createReceipt(data: any) {
  return NativeReceipt.create(data);
}

export async function updateReceipt(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeReceipt.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteReceipt(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeReceipt.findOneAndDelete({ _id: id, tenantId: tid });
}
