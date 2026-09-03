import mongoose from 'mongoose';
import { NativeExpense } from './expense.model';
import { ExpenseListOptions } from './expense.types';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';

export async function listExpenses(tenantId: string, opts: ExpenseListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

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

export async function getExpenseById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeExpense.findOne(filter);
}

export async function createExpense(data: any) {
  const created = await NativeExpense.create(data);
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'expenses', created.toObject(), (created as any).title);
  return created;
}

export async function updateExpense(id: string, tenantId: string, data: any, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const updated = await NativeExpense.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'expenses', updated.toObject(), (updated as any).title);
  return updated;
}

export async function deleteExpense(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeExpense.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'expenses', String(deleted._id));
  return deleted;
}
