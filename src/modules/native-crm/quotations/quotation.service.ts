import mongoose from 'mongoose';
import { NativeQuotation } from './quotation.model';
import { NativeContract } from '../contracts/contract.model';
import { QuotationListOptions } from './quotation.types';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { NativeTeam } from '../teams/team.model';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { resolveDateRange, applyDateRangeToFilter } from '../shared/date-range';
import { applyDynamicFilters } from '../shared/dynamic-filter';
import { getQuotationFilterCatalog } from './quotation.filter-catalog';

async function assertValidStatus(tenantId: string, status: string | undefined): Promise<void> {
  if (!status) return;
  if (!(await isValidStageKey(tenantId, 'quotation', status))) {
    throw new Error(`"${status}" is not a valid stage for this tenant's Quotation pipeline`);
  }
}

const QUOTATION_DATE_FIELDS = new Set(['validUntil', 'createdAt']);

export async function listQuotations(tenantId: string, opts: QuotationListOptions, branchId?: string | null, scope?: DataScope) {
  const tid   = new mongoose.Types.ObjectId(tenantId);
  const page  = Number(opts.page  ?? 1);
  const limit = Number(opts.limit ?? 20);
  const filter: any = { tenantId: tid };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  applyDataScopeToCreatedByFilter(filter, scope);

  if (opts.status) filter.status = opts.status;
  if (opts.search) filter.$or = [
    { title:      new RegExp(opts.search, 'i') },
    { customerId: new RegExp(opts.search, 'i') },
  ];
  if (opts.teamId) {
    const team = await NativeTeam.findOne({ _id: opts.teamId, tenantId: tid }).select('teamId').lean();
    filter.teamId = team?.teamId ?? '__no_match__';
  }
  if (opts.staffId) filter.staffId = opts.staffId;
  const dateField = opts.dateField && QUOTATION_DATE_FIELDS.has(opts.dateField) ? opts.dateField : 'createdAt';
  applyDateRangeToFilter(filter, dateField, resolveDateRange(opts.range, opts.dateFrom, opts.dateTo));
  if (opts.filters) {
    const catalog = await getQuotationFilterCatalog(tenantId, branchId);
    applyDynamicFilters(filter, opts.filters, catalog);
  }

  const [items, total] = await Promise.all([
    NativeQuotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    NativeQuotation.countDocuments(filter),
  ]);
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getQuotationById(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeQuotation.findOne(filter);
}

export async function createQuotation(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  const services: any[]  = data.services ?? [];
  const parts: any[]     = data.parts ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(data.discount ?? 0);
  const gst      = Number(data.gstPercentage ?? 0);
  // discount is a percentage (0-100), not a flat amount — matches the
  // on-screen preview in ServiceLinesEditor.tsx.
  const subtotal = svcTotal + prtTotal;
  const after    = subtotal - (subtotal * discount) / 100;
  const created = await NativeQuotation.create({
    ...data,
    partsAmount:           prtTotal,
    servicesAmount:        after,
    servicesAmountWithTax: after + (after * gst) / 100,
  });
  // Mirrors the identical source-linking pattern already used by
  // createWorkorder/createContract/createInvoice — marks the source
  // Contract workflowState='complete' once a Quotation has been created
  // from it, so the Contract row's "convert" button (once that also checks
  // workflowState) stops offering to convert it again.
  if (data.createdBy !== 'system' && data.contractId) {
    const src = await NativeContract.findOne({ contractId: data.contractId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'quotation', mongoId: (created._id as any).toString() }).catch(() => {});
  }
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'quotations', created.toObject(), created.title);
  return created;
}

export async function updateQuotation(id: string, tenantId: string, data: any, scope?: DataScope) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeQuotation.findOne(filter).lean();
    const services  = data.services        ?? (existing as any)?.services        ?? [];
    const parts     = data.parts           ?? (existing as any)?.parts           ?? [];
    const discount  = Number(data.discount      ?? (existing as any)?.discount      ?? 0);
    const gst       = Number(data.gstPercentage ?? (existing as any)?.gstPercentage ?? 0);
    const svcTotal  = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
    const prtTotal  = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
    // discount is a percentage (0-100), not a flat amount — matches createQuotation.
    const subtotal  = svcTotal + prtTotal;
    const after     = subtotal - (subtotal * discount) / 100;
    data.partsAmount           = prtTotal;
    data.servicesAmount        = after;
    data.servicesAmountWithTax = after + (after * gst) / 100;
  }
  const updated = await NativeQuotation.findOneAndUpdate(
    filter,
    data,
    { new: true, runValidators: true }
  );
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'quotations', updated.toObject(), updated.title);
  return updated;
}

export async function deleteQuotation(id: string, tenantId: string, scope?: DataScope) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { _id: id, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeQuotation.findOneAndDelete(filter);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'quotations', String(deleted._id));
  return deleted;
}
