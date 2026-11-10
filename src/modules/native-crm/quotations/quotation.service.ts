import mongoose from 'mongoose';
import { NativeQuotation } from './quotation.model';
import { NativeContract } from '../contracts/contract.model';
import { NativeCustomer } from '../customers/customer.model';
import { QuotationListOptions } from './quotation.types';
import { isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { DataScope } from '../../../types';
import { applyDataScopeToCreatedByFilter } from '../shared/data-scope';
import { NativeTeam } from '../teams/team.model';
import { indexNativeSearchRecord, removeNativeSearchRecord } from '../shared/search-index';
import { advanceWorkflow } from '../workflow/workflow.engine';
import { resolveDateRange, applyDateRangeToFilter } from '../shared/date-range';
import { applyDynamicFilters } from '../shared/dynamic-filter';
import { computeDocumentTotals } from '../shared/document-totals';
import { getQuotationFilterCatalog } from './quotation.filter-catalog';
import { WriteGuard, withExpectedVersion, throwIfStale } from '../../../utils/stale-write';

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
  if (opts.customerId) {
    filter.customerId = opts.customerId;
    const cust = await NativeCustomer.findOne({ tenantId: tid, customerId: opts.customerId }).select('createdAt').lean();
    if (cust?.createdAt) {
      if (filter.createdAt) {
        filter.$and = [{ createdAt: filter.createdAt }, { createdAt: { $gte: cust.createdAt } }];
        delete filter.createdAt;
      } else {
        filter.createdAt = { $gte: cust.createdAt };
      }
    }
  }
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
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { quotationId: id }] }
    : { quotationId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  return NativeQuotation.findOne(filter);
}

export async function createQuotation(data: any) {
  await assertValidStatus(String(data.tenantId), data.status);
  // Totals: NC/shared/document-totals.ts (pinned by tests/document-totals-golden.test.ts).
  // discount is a percentage (0-100), not a flat amount — matches the
  // on-screen preview in ServiceLinesEditor.tsx.
  const t = computeDocumentTotals('quotation', { services: data.services, parts: data.parts, discount: data.discount, gstPercentage: data.gstPercentage });
  const created = await NativeQuotation.create({
    ...data,
    partsAmount:           t.partsAmount,
    servicesAmount:        t.servicesAmount,
    servicesAmountWithTax: t.servicesAmountWithTax,
  });
  // Mirrors the identical source-linking pattern already used by
  // createWorkorder/createContract/createInvoice — marks the source
  // Contract workflowState='complete' once a Quotation has been created
  // from it, so the Contract row's "convert" button (once that also checks
  // workflowState) stops offering to convert it again. Scoped to this
  // quotation's own tenant: the contract id comes from the caller and is
  // not otherwise checked against it.
  if (data.createdBy !== 'system' && data.contractId) {
    const src = await NativeContract.findOne({ tenantId: created.tenantId, contractId: data.contractId }).select('_id').lean();
    if (src) advanceWorkflow({ type: 'contract', mongoId: (src._id as any).toString() }, { type: 'quotation', mongoId: (created._id as any).toString() }, created.tenantId).catch(() => {});
  }
  indexNativeSearchRecord(String(created.tenantId), 'native-crm', 'quotations', created.toObject(), created.title);
  return created;
}

export async function updateQuotation(id: string, tenantId: string, data: any, scope?: DataScope, guard?: WriteGuard) {
  await assertValidStatus(tenantId, data.status);
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { quotationId: id }] }
    : { quotationId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  if (data.services !== undefined || data.parts !== undefined || data.discount !== undefined || data.gstPercentage !== undefined) {
    const existing = await NativeQuotation.findOne(filter).lean();
    // Totals: NC/shared/document-totals.ts (pinned by tests/document-totals-golden.test.ts).
    // discount is a percentage (0-100), not a flat amount — matches createQuotation.
    // Number() of discount and GST first, as before the shared function: the same value, and the
    // same error first for a body without the screen's Zod.
    const t = computeDocumentTotals('quotation', {
      services:      data.services      ?? (existing as any)?.services,
      parts:         data.parts         ?? (existing as any)?.parts,
      discount:      Number(data.discount      ?? (existing as any)?.discount      ?? 0),
      gstPercentage: Number(data.gstPercentage ?? (existing as any)?.gstPercentage ?? 0),
    });
    data.partsAmount           = t.partsAmount;
    data.servicesAmount        = t.servicesAmount;
    data.servicesAmountWithTax = t.servicesAmountWithTax;
  }
  const updated = await NativeQuotation.findOneAndUpdate(
    withExpectedVersion(filter, guard),
    data,
    { new: true, runValidators: true }
  );
  if (!updated) await throwIfStale(NativeQuotation, filter, guard);
  if (updated) indexNativeSearchRecord(tenantId, 'native-crm', 'quotations', updated.toObject(), updated.title);
  return updated;
}

export async function deleteQuotation(id: string, tenantId: string, scope?: DataScope, guard?: WriteGuard) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const idFilter = mongoose.isValidObjectId(id)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { quotationId: id }] }
    : { quotationId: id };
  const filter: Record<string, unknown> = { ...idFilter, tenantId: tid };
  applyDataScopeToCreatedByFilter(filter, scope);
  const deleted = await NativeQuotation.findOneAndDelete(withExpectedVersion(filter, guard));
  if (!deleted) await throwIfStale(NativeQuotation, filter, guard);
  if (deleted) removeNativeSearchRecord(tenantId, 'native-crm', 'quotations', String(deleted._id));
  return deleted;
}
