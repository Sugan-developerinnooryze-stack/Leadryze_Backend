import mongoose from 'mongoose';
import { NativeProduct } from './product.model';

export async function listProducts(tenantId: string, opts: any, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { name: new RegExp(opts.search, 'i') },
    { sku:  new RegExp(opts.search, 'i') },
  ];
  const [items, total] = await Promise.all([
    NativeProduct.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeProduct.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getProductById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeProduct.findOne({ _id: id, tenantId: tid });
}

export async function createProduct(data: any) {
  return NativeProduct.create(data);
}

export async function updateProduct(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeProduct.findOneAndUpdate({ _id: id, tenantId: tid }, data, { new: true, runValidators: true });
}

export async function deleteProduct(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeProduct.findOneAndDelete({ _id: id, tenantId: tid });
}
