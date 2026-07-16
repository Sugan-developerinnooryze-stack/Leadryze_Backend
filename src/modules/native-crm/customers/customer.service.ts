import mongoose from 'mongoose';
import { NativeCustomer } from './customer.model';
import { CustomerListOptions } from './customer.types';
import { ensureCredentials } from '../shared/app-credentials.service';

export async function listCustomers(tenantId: string, opts: CustomerListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name:  new RegExp(opts.search, 'i') },
    { email: new RegExp(opts.search, 'i') },
    { phone: new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeCustomer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeCustomer.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getCustomerById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCustomer.findOne({ _id: id, tenantId: tid });
}

export async function createCustomer(data: any) {
  const doc = await NativeCustomer.create(data);
  // Auto-generate customer-app login credentials — never blocks/breaks creation
  await ensureCredentials(NativeCustomer, doc._id, doc.tenantId, data.name ?? '');
  return doc;
}

export async function updateCustomer(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCustomer.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteCustomer(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeCustomer.findOneAndDelete({ _id: id, tenantId: tid });
}
