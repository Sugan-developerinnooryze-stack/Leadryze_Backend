import mongoose from 'mongoose';
import { CustomModuleDef, CustomRecord, ICustomModuleDef, ICustomRecord } from './custom-module.model';
import { isValidStageKey } from '../native-crm/pipeline-config/pipeline-config.service';
import { runAutomations, runAutomationsOnCreate, runAutomationsOnUpdate, runAutomationsOnDelete } from '../native-crm/automation-rules/automation-rule.service';

/** Validates the tenant's designated pipeline field (if any) against their
 * own configured stage list for this custom module — same app-layer
 * validation the 8 built-in modules already do, just keyed by `custom:<slug>`
 * instead of a fixed module name. No-ops for modules with no pipeline field
 * configured, or updates that don't touch it. */
async function assertValidPipelineField(
  tenantId: string, moduleSlug: string, data: Record<string, unknown>,
): Promise<void> {
  const def = await CustomModuleDef.findOne({ tenantId, slug: moduleSlug }).select('pipelineFieldKey').lean();
  const fieldKey = def?.pipelineFieldKey;
  if (!fieldKey || data[fieldKey] === undefined) return;
  const value = String(data[fieldKey]);
  if (!(await isValidStageKey(tenantId, `custom:${moduleSlug}`, value))) {
    throw new Error(`"${value}" is not a valid stage for this module's pipeline`);
  }
}

/** Fire-and-forget hook-in point, same shape as every built-in module's
 * controller call — resolves the pipeline field's new value and, if this
 * module has one configured, runs any matching automation rules.
 *
 * `depth` defaults to 0 for every normal, human-initiated create/update
 * (the only kind that reaches this function via the HTTP controllers) —
 * it's only ever non-zero when a create_linked_record automation itself
 * created or is otherwise responsible for this record, threaded in from
 * createCustomRecord below. Without this, a tenant could configure two
 * Custom Modules whose automations create records in each other and the
 * cycle would run forever: this is the ONLY depth-tracking that exists for
 * chains flowing through a Custom Module's own automation hooks, since
 * runAutomations/runAutomationsOnCreate enforce the actual cap centrally. */
function fireCustomModuleAutomations(
  tenantId: string, moduleSlug: string, record: { data?: Record<string, unknown> } & Record<string, any>,
  depth = 0,
): void {
  CustomModuleDef.findOne({ tenantId, slug: moduleSlug }).select('pipelineFieldKey').lean()
    .then((def) => {
      const fieldKey = def?.pipelineFieldKey;
      const recordData = record.data as Record<string, unknown> | undefined;
      const value = fieldKey ? recordData?.[fieldKey] : undefined;
      if (fieldKey && value !== undefined) {
        runAutomations(tenantId, `custom:${moduleSlug}`, record, String(value), depth).catch(() => {});
      }
    })
    .catch(() => {});
}

/** Same fire-and-forget shape as fireCustomModuleAutomations, but for
 * 'record_created' rules — these don't need a pipeline field configured at
 * all, since they trigger on creation regardless of any field's value. */
function fireCustomModuleAutomationsOnCreate(
  tenantId: string, moduleSlug: string, record: { data?: Record<string, unknown> } & Record<string, any>,
  depth = 0,
): void {
  runAutomationsOnCreate(tenantId, `custom:${moduleSlug}`, record, depth).catch(() => {});
}

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
    pipelineFieldKey: dto.pipelineFieldKey,
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
  /** Only ever passed by automation-rule.service.ts's create_linked_record
   * dispatcher, one level deeper than whatever chain led to this creation —
   * see fireCustomModuleAutomations' comment for why this exists at all. */
  depth = 0,
): Promise<any> {
  await assertValidPipelineField(tenantId, moduleSlug, data);

  const last: any = await CustomRecord.findOne({ tenantId, moduleSlug }).sort({ numId: -1 }).lean();
  const numId = (last?.numId ?? 0) + 1;
  const recordId = `${moduleSlug.toUpperCase().replace(/-/g, '')}-${String(numId).padStart(4, '0')}`;

  const rec = await CustomRecord.create({ tenantId, moduleSlug, numId, recordId, data, createdBy });
  const plain = rec.toObject();
  fireCustomModuleAutomations(tenantId, moduleSlug, plain, depth);
  fireCustomModuleAutomationsOnCreate(tenantId, moduleSlug, plain, depth);
  return plain;
}

export async function updateCustomRecord(
  tenantId: string,
  moduleSlug: string,
  id: string,
  data: Record<string, unknown>,
): Promise<any | null> {
  await assertValidPipelineField(tenantId, moduleSlug, data);

  // Fetched before the update specifically so runAutomationsOnUpdate (below)
  // can diff old vs new field values — without this there'd be no way to
  // tell "field updated" rules apart from a no-op resave.
  const prev = await CustomRecord.findOne({ tenantId, moduleSlug, _id: id }).lean();

  const rec = await CustomRecord.findOneAndUpdate(
    { tenantId, moduleSlug, _id: id },
    { $set: { data } },
    { new: true },
  ).lean();
  if (rec) {
    fireCustomModuleAutomations(tenantId, moduleSlug, rec);
    if (prev) runAutomationsOnUpdate(tenantId, `custom:${moduleSlug}`, prev, rec).catch(() => {});
  }
  return rec;
}

export async function deleteCustomRecord(
  tenantId: string,
  moduleSlug: string,
  id: string,
): Promise<any | null> {
  // findOneAndDelete (not deleteOne) specifically so the record's last-known
  // field values are available to runAutomationsOnDelete — deleteOne never
  // materializes the document at all, so those values would otherwise be
  // gone before any hook could read them.
  const rec = await CustomRecord.findOneAndDelete({ tenantId, moduleSlug, _id: id }).lean();
  if (rec) runAutomationsOnDelete(tenantId, `custom:${moduleSlug}`, rec).catch(() => {});
  return rec;
}
