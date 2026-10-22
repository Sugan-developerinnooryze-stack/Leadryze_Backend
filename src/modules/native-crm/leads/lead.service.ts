import mongoose from 'mongoose';
import { Lead } from './lead.model';
import { LeadListOptions } from './lead.types';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToFilter } from '../shared/data-scope';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { customFieldsSearchExpr } from '../shared/custom-field-query';
import { conditionsToMongoFilter } from '../automation-rules/automation-rule.service';
import { IFlowCondition } from '../automation-rules/automation-rule.model';
import { hashEmail } from '../../../platform/pii/pii.service';
import { NativeStaff } from '../staffs/staff.model';

function leadDisplayName(l: any): string {
  return [l.firstName, l.lastName].filter(Boolean).join(' ') || l.company || l.leadId;
}

async function assertValidOwner(tenantId: string, leadOwnerStaffId: string | undefined): Promise<void> {
  if (!leadOwnerStaffId) return;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const isFsStaff = await NativeStaff.exists({
    tenantId: tid,
    $or: [
      { staffId: leadOwnerStaffId },
      ...(mongoose.isValidObjectId(leadOwnerStaffId) ? [{ _id: new mongoose.Types.ObjectId(leadOwnerStaffId) }] : []),
    ],
  });
  if (isFsStaff) {
    throw new Error('Field Service staff cannot be assigned as Lead Owner. Please select a CRM user.');
  }
}

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'lead', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Lead pipeline`);
  }
}

function buildLeadFilter(tenantId: string, opts: LeadListOptions, branchId?: string | null, scope?: DataScope): Record<string, any> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', opts.owner === 'unassigned' ? 'unassigned' : undefined, undefined, 'createdBy');

  if (opts.status)     filter.status   = opts.status;
  if (opts.source)     filter.source   = opts.source;
  if (opts.rating)     filter.rating   = opts.rating;
  if (opts.priority)   filter.priority = opts.priority;
  if (opts.leadOwner)  filter.leadOwner = opts.leadOwner;
  if (opts.isConverted !== undefined)
    filter.isConverted = opts.isConverted === 'true';

  if (opts.search) {
    // LR-LEAD-006: unescaped regex metacharacters (e.g. "+" in a phone
    // number) crashed this with "Invalid regular expression: Nothing to
    const rawSearch = opts.search.trim();
    const re = new RegExp(rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // LR-LEAD-005: email/phone are encrypted at rest, so a regex against
    // those columns directly can only ever match the rare row that's still
    // plaintext by accident — match the blind-index fields instead
    // (phoneSearch/emailSearch, derived in lead.model.ts's own pre-save
    // hook and pii.service.ts) so every correctly-encrypted lead is
    // findable by the same search a user would actually type.
    const orClauses: Record<string, unknown>[] = [
      { firstName: re }, { lastName: re },
      { company: re }, { leadId: re },
      customFieldsSearchExpr(opts.search),
    ];
    // LR-C4-SRCH-002: Searching a lead by full name ("first last") finds the lead
    const nameTokens = rawSearch.split(/\s+/).filter(Boolean);
    if (nameTokens.length >= 2) {
      const firstToken = nameTokens[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const restTokens = nameTokens.slice(1).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orClauses.push({
        $and: [
          { firstName: new RegExp(firstToken, 'i') },
          { lastName: new RegExp(restTokens, 'i') },
        ],
      });
      orClauses.push({
        $and: [
          { firstName: new RegExp(restTokens, 'i') },
          { lastName: new RegExp(firstToken, 'i') },
        ],
      });
      const fullNamePattern = nameTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      orClauses.push({
        $expr: {
          $regexMatch: {
            input: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] },
            regex: fullNamePattern,
            options: 'i',
          },
        },
      });
    }
    const searchDigits = opts.search.replace(/\D/g, '');
    if (searchDigits.length >= 4) {
      orClauses.push({ phoneSearch: new RegExp('^' + searchDigits) });
    }
    if (opts.search.includes('@')) {
      orClauses.push({ emailSearch: hashEmail(opts.search) });
    }
    if (filter.$or) {
      const existingOr = filter.$or;
      delete filter.$or;
      filter.$and = [...(filter.$and ?? []), { $or: existingOr }, { $or: orClauses }];
    } else {
      filter.$or = orClauses;
    }
  }

  if (opts.customFieldFilters) {
    try {
      const conditions: IFlowCondition[] = JSON.parse(opts.customFieldFilters);
      const cfFilter = conditionsToMongoFilter(conditions);
      if (Object.keys(cfFilter).length > 0) filter.$and = [...(filter.$and ?? []), cfFilter];
    } catch { /* malformed filter payload from the client — ignored, not a 500 */ }
  }
  return filter;
}

/** `sortBy` accepts a built-in field name or `customFields.<key>` — both
 * sort identically via Mongo's native dot-path sort, no special-casing
 * needed. Falls back to the original hardcoded sort when omitted, so every
 * existing caller's behavior is unchanged. */
function resolveLeadSort(opts: LeadListOptions): Record<string, 1 | -1> {
  if (!opts.sortBy) return { lastActivityAt: -1, createdAt: -1 };
  const dir: 1 | -1 = opts.sortDir === 'desc' ? -1 : 1;
  if (opts.sortBy === '_displayName' || opts.sortBy === 'name') {
    return { firstName: dir, lastName: dir, company: dir };
  }
  return { [opts.sortBy]: dir };
}

export async function listLeads(tenantId: string, opts: LeadListOptions, branchId?: string | null, scope?: DataScope) {
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 50);
  const filter = buildLeadFilter(tenantId, opts, branchId, scope);

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .select('-emailSearch -phoneSearch -emailDomain')
      .sort(resolveLeadSort(opts))
      // LR-LEAD-007: default binary string sort put every capital letter
      // before every lowercase one ("Zed" before "adam") — a case-
      // insensitive collation sorts the way a person actually expects.
      .collation({ locale: 'en', strength: 2 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

/** Same filters as listLeads, no pagination — for CSV export, which must
 * return every matching record rather than one page of results. */
export async function listLeadsForExport(tenantId: string, opts: LeadListOptions, branchId?: string | null, scope?: DataScope) {
  const filter = buildLeadFilter(tenantId, opts, branchId, scope);
  return Lead.find(filter)
    .select('-emailSearch -phoneSearch -emailDomain')
    .sort(resolveLeadSort(opts))
    .lean();
}

export async function getLeadById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idClauses: any[] = [{ leadId: id }];
  if (mongoose.isValidObjectId(id)) {
    idClauses.push({ _id: new mongoose.Types.ObjectId(id) });
  }
  const filter: any = { tenantId: tid, $or: idClauses };
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', undefined, undefined, 'createdBy');
  return Lead.findOne(filter).select('-emailSearch -phoneSearch -emailDomain');
}

export async function createLead(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  await assertValidOwner(String(data.tenantId), data.leadOwnerStaffId);
  const doc = await Lead.create(data);
  indexNativeSearchRecord(String(doc.tenantId), 'native', 'leads', doc.toObject(), leadDisplayName(doc));
  return doc;
}

export async function updateLead(id: string, tenantId: string, data: any, scope?: DataScope) {
  await assertValidStatus(tenantId, data.status);
  await assertValidOwner(tenantId, data.leadOwnerStaffId);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', undefined, undefined, 'createdBy');
  // LR-LEAD-005: findOneAndUpdate() bypasses the pre('save') hooks that
  // encrypt email/phone/etc and derive the blind-index search fields —
  // load-then-save so an edited lead is encrypted exactly like a newly
  // created one, instead of being written back as plaintext.
  const updated = await Lead.findOne(filter);
  if (!updated) return null;

  // LR-NEG-001: Detect stale concurrent save (lost update prevention) — version token mandatory
  const clientUpdatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : null;
  const clientVersion = data.__v !== undefined ? Number(data.__v) : (data.version !== undefined ? Number(data.version) : null);
  if (clientVersion === null && clientUpdatedAt === null) {
    const err: any = new Error('This lead was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientVersion !== null && updated.__v !== undefined && updated.__v !== clientVersion) {
    const err: any = new Error('This lead was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientUpdatedAt && (updated as any).updatedAt) {
    const docTime = new Date((updated as any).updatedAt).getTime();
    if (docTime - clientUpdatedAt > 500) {
      const err: any = new Error('This lead was changed by someone else — please reload and try again.');
      err.name = 'VersionError';
      throw err;
    }
  }

  const { updatedAt: _u, __v: _v, version: _ver, ...cleanData } = data;

  // LR-C4-LEAD-003: If email or phone contains masking characters (* or X),
  // never overwrite real stored PII with the masked string
  const PII_FIELDS = ['email', 'secondaryEmail', 'phone', 'mobile', 'whatsapp', 'alternatePhone'];
  for (const f of PII_FIELDS) {
    const val = (cleanData as any)[f];
    if (typeof val === 'string' && (val.includes('*') || /X{2,}/.test(val))) {
      delete (cleanData as any)[f];
    }
  }

  updated.set({ ...cleanData, lastActivityAt: new Date() });
  await updated.save();
  indexNativeSearchRecord(tenantId, 'native', 'leads', updated.toObject(), leadDisplayName(updated));
  return updated;
}

export async function updateLeadStage(
  id: string,
  tenantId: string,
  status: string,
  scope?: DataScope,
  versionToken?: { updatedAt?: any; __v?: any; version?: any }
) {
  await assertValidStatus(tenantId, status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', undefined, undefined, 'createdBy');

  const lead = await Lead.findOne(filter);
  if (!lead) return null;

  // LR-NEG-001: Stage move must also be version-checked
  const clientUpdatedAt = versionToken?.updatedAt ? new Date(versionToken.updatedAt).getTime() : null;
  const clientVersion = versionToken?.__v !== undefined ? Number(versionToken.__v) : (versionToken?.version !== undefined ? Number(versionToken.version) : null);
  if (clientVersion === null && clientUpdatedAt === null) {
    const err: any = new Error('This lead was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientVersion !== null && lead.__v !== undefined && lead.__v !== clientVersion) {
    const err: any = new Error('This lead was changed by someone else — please reload and try again.');
    err.name = 'VersionError';
    throw err;
  }
  if (clientUpdatedAt && (lead as any).updatedAt) {
    const docTime = new Date((lead as any).updatedAt).getTime();
    if (docTime - clientUpdatedAt > 500) {
      const err: any = new Error('This lead was changed by someone else — please reload and try again.');
      err.name = 'VersionError';
      throw err;
    }
  }

  lead.status = status;
  lead.lastActivityAt = new Date();
  await lead.save();
  indexNativeSearchRecord(tenantId, 'native', 'leads', lead.toObject(), leadDisplayName(lead));
  return lead;
}

export async function deleteLead(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', undefined, undefined, 'createdBy');
  const deleted = await Lead.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native', 'leads', String(deleted._id));
  return deleted;
}

export async function getLeadRaw(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: any = { _id: id, tenantId: tid };
  applyDataScopeToFilter(filter, scope, 'leadOwnerStaffId', undefined, undefined, 'createdBy');
  return Lead.findOne(filter);
}
