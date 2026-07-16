import mongoose from 'mongoose';
import { CustomModuleDef, CustomRecord, ICustomModuleDef, ICustomRecord } from './custom-module.model';

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/* ── Module Definition CRUD ───────────────────────────────────────────────── */

export async function listCustomModules(tenantId: string): Promise<any[]> {
  return CustomModuleDef.find({ tenantId }).sort({ menuOrder: 1, createdAt: 1 }).lean();
}

export async function getCustomModuleBySlug(tenantId: string, slug: string): Promise<any | null> {
  return CustomModuleDef.findOne({ tenantId, slug }).lean();
}

export async function getCustomModuleById(tenantId: string, id: string): Promise<any | null> {
  return CustomModuleDef.findOne({ tenantId, _id: id }).lean();
}

export async function createCustomModule(tenantId: string, dto: Partial<ICustomModuleDef>): Promise<any> {
  const base = toSlug(dto.name ?? 'module') || 'module';
  let slug = base;
  let attempt = 0;
  while (await CustomModuleDef.exists({ tenantId, slug })) {
    attempt++;
    slug = `${base}-${attempt}`;
  }

  const lastMod = await CustomModuleDef.findOne({ tenantId }).sort({ menuOrder: -1 }).lean();
  const menuOrder = ((lastMod as any)?.menuOrder ?? 0) + 1;

  const mod = await CustomModuleDef.create({
    tenantId,
    slug,
    name:          dto.name,
    singularName:  dto.singularName ?? dto.name,
    icon:          dto.icon          ?? '📋',
    color:         dto.color         ?? '#6366f1',
    showInSidebar: dto.showInSidebar ?? true,
    menuOrder,
    fields:        dto.fields ?? [],
  });
  return mod.toObject();
}

export async function updateCustomModule(
  tenantId: string,
  id: string,
  dto: Partial<ICustomModuleDef>,
): Promise<any | null> {
  const { slug: _slug, tenantId: _tid, ...safe } = dto as any;
  return CustomModuleDef.findOneAndUpdate(
    { tenantId, _id: id },
    { $set: safe },
    { new: true, runValidators: true },
  ).lean();
}

export async function deleteCustomModule(tenantId: string, id: string): Promise<boolean> {
  const mod: any = await CustomModuleDef.findOne({ tenantId, _id: id }).lean();
  if (!mod) return false;
  await CustomRecord.deleteMany({ tenantId, moduleSlug: mod.slug });
  await CustomModuleDef.deleteOne({ tenantId, _id: id });
  return true;
}

/* ── Custom Record CRUD ───────────────────────────────────────────────────── */

interface ListOpts {
  page?:   number;
  limit?:  number;
  search?: string;
}

export async function listCustomRecords(
  tenantId: string,
  moduleSlug: string,
  opts: ListOpts = {},
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const page  = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, opts.limit ?? 20);
  const skip  = (page - 1) * limit;

  const filter: mongoose.FilterQuery<ICustomRecord> = { tenantId, moduleSlug };
  if (opts.search) {
    filter['$or'] = [
      { 'data.name':  { $regex: opts.search, $options: 'i' } },
      { 'data.title': { $regex: opts.search, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    CustomRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CustomRecord.countDocuments(filter),
  ]);

  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function getCustomRecord(
  tenantId: string,
  moduleSlug: string,
  id: string,
): Promise<any | null> {
  return CustomRecord.findOne({ tenantId, moduleSlug, _id: id }).lean();
}

export async function createCustomRecord(
  tenantId: string,
  moduleSlug: string,
  data: Record<string, unknown>,
  createdBy?: string,
): Promise<any> {
  const last: any = await CustomRecord.findOne({ tenantId, moduleSlug }).sort({ numId: -1 }).lean();
  const numId = (last?.numId ?? 0) + 1;
  const recordId = `${moduleSlug.toUpperCase().replace(/-/g, '')}-${String(numId).padStart(4, '0')}`;

  const rec = await CustomRecord.create({ tenantId, moduleSlug, numId, recordId, data, createdBy });
  return rec.toObject();
}

export async function updateCustomRecord(
  tenantId: string,
  moduleSlug: string,
  id: string,
  data: Record<string, unknown>,
): Promise<any | null> {
  return CustomRecord.findOneAndUpdate(
    { tenantId, moduleSlug, _id: id },
    { $set: { data } },
    { new: true },
  ).lean();
}

export async function deleteCustomRecord(
  tenantId: string,
  moduleSlug: string,
  id: string,
): Promise<boolean> {
  const result = await CustomRecord.deleteOne({ tenantId, moduleSlug, _id: id });
  return result.deletedCount > 0;
}
