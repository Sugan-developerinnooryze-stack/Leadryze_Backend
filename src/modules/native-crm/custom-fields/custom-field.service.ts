import mongoose from 'mongoose';
import { NativeCustomField } from './custom-field.model';
import { assertValidCustomFieldDefinition } from './custom-field-definition.validator';

export async function listCustomFields(tenantId: string, module?: string, branchId?: string | null) {
  const filter: Record<string, any> = { tenantId: new mongoose.Types.ObjectId(tenantId), isActive: true };
  if (module) filter.module = module;
  // Strict per-branch isolation, matching the reported expectation exactly —
  // a field created under one branch must not leak into another branch's
  // view. branchId:null (no branch selected / tenant-wide) intentionally
  // only ever matches other branchId:null fields, never a specific branch's.
  filter.branchId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  return NativeCustomField.find(filter).sort({ order: 1 }).lean();
}

export async function getCustomFieldById(id: string, tenantId: string) {
  return NativeCustomField.findOne({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) }).lean();
}

export async function createCustomField(tenantId: string, data: Record<string, any>, branchId?: string | null) {
  const existing = await listCustomFields(tenantId, data.module, branchId ?? null);
  assertValidCustomFieldDefinition(data as any, existing.map((f: any) => f.fieldKey));

  return NativeCustomField.create({
    ...data,
    tenantId: new mongoose.Types.ObjectId(tenantId),
    branchId: branchId ? new mongoose.Types.ObjectId(branchId) : null,
  });
}

export async function updateCustomField(id: string, tenantId: string, data: Record<string, any>) {
  // Merge onto the existing field before validating — same partial-update
  // care as Custom Module definitions/records this session: a caller
  // changing only `required` or `label` must not be rejected just because
  // the merged view temporarily looks incomplete without this.
  const current = await NativeCustomField.findOne({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) }).lean();
  if (!current) return null;
  const merged = { ...current, ...data };
  const siblings = await listCustomFields(tenantId, merged.module, (current as any).branchId ?? null);
  const existingKeys = siblings.map((f: any) => f.fieldKey).filter((k: string) => k !== (current as any).fieldKey);
  assertValidCustomFieldDefinition(merged as any, existingKeys);

  return NativeCustomField.findOneAndUpdate(
    { _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) },
    { $set: data },
    { new: true }
  ).lean();
}

export async function deleteCustomField(id: string, tenantId: string) {
  return NativeCustomField.findOneAndDelete({ _id: id, tenantId: new mongoose.Types.ObjectId(tenantId) }).lean();
}
