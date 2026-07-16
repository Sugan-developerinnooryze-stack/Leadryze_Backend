import mongoose from 'mongoose';
import { NativeExpense } from './expense.model';
import { ExpenseListOptions } from './expense.types';

export async function listExpenses(tenantId: string, opts: ExpenseListOptions, branchId?: string | null) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:    new RegExp(opts.search, 'i') },
    { category: new RegExp(opts.search, 'i') },
    { paidBy:   new RegExp(opts.search, 'i') },
  ];

  const [items, total] = await Promise.all([
    NativeExpense.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeExpense.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getExpenseById(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeExpense.findOne({ _id: id, tenantId: tid });
}

export async function createExpense(data: any) {
  return NativeExpense.create(data);
}

export async function updateExpense(id: string, tenantId: string, data: any) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeExpense.findOneAndUpdate(
    { _id: id, tenantId: tid },
    data,
    { new: true, runValidators: true }
  );
}

export async function deleteExpense(id: string, tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NativeExpense.findOneAndDelete({ _id: id, tenantId: tid });
}
