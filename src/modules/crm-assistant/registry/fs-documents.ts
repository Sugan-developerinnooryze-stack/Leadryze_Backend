import type { FieldCap, FieldKind, ModuleCap } from './types';
import { ROUTE_TEMPLATES } from '../contracts/routes';
import { NativeQuotation } from '../../native-crm/quotations/quotation.model';
import { NativeContract } from '../../native-crm/contracts/contract.model';
import { NativeReceipt } from '../../native-crm/receipts/receipt.model';

/* Field Service documents the assistant reads (Increment 5, decision D7):
 * quotations, contracts and receipts. Contracts and receipts are never
 * written: their module-map entries have no create, update or delete
 * closure, so the gateway and the staged operations refuse every change.
 * Quotations are created and changed only through the guided form
 * (Increment 7, M21; never deleted, D20): /crm-write and the legacy staged
 * path refuse them.
 *
 * The same tiers as field-service.ts: 'list' and 'detail' fields are only
 * ones the module map's read projection (readFields) keeps; 'hidden' fields
 * drive the engine and are never shown; every other schema path is in
 * ignoredPaths with its reason. None of the three is registered PII, so the
 * free-text address a quotation or contract copies from its customer, and
 * notes, are not offered at all (as on the invoice). Amounts carry no
 * currency of their own: the screens show them in the branch's Field Service
 * currency, and the assistant in each record's own company's
 * (execute-list.ts withRecordCurrencies). getById of all three applies the
 * caller's scope but not the branch, as the invoice's does. */

type Read = FieldCap['read'];
type Ignored = ModuleCap['ignoredPaths'];

// The helpers field-service.ts uses.
const f = (path: string, label: string, kind: FieldKind, read: Read, extra: Partial<FieldCap> = {}): FieldCap =>
  ({ key: path, path, label, kind, read, ...extra });
const col = (priority: 1 | 2 | 3): Partial<FieldCap> => ({ priority });
const created = (read: Read): FieldCap => f('createdAt', 'Created', 'datetime', read, { dateRule: 'instant' });
const updated = (): FieldCap => f('updatedAt', 'Updated', 'datetime', 'detail', { dateRule: 'instant' });
const branchMoney: Partial<FieldCap> = { money: { currency: 'fs_branch' } };
const fromSchema: Partial<FieldCap> = { enumFrom: 'schema' };
const business = (module: string, targetField: string): Partial<FieldCap> => ({ ref: { module, targetField, idFormat: 'business' } });

const BASE: Ignored = {
  _id: 'system', __v: 'system', tenantId: 'system', branchId: 'system', clientId: 'internal', numId: 'internal',
  createdBy: 'system', customFields: 'detail_only',
};
const LOCKS: Ignored = { isLocked: 'system', lockedAt: 'system', lockedBy: 'system', lockReason: 'system' };
/** What a quotation and a contract share and never offer: the customer's
 * address copied as free text, notes and terms, the document-chain state and
 * the public portal link's token. */
const DOCUMENT_TEXT: Ignored = {
  address: 'detail_only', notes: 'detail_only', termsAndConditions: 'detail_only', workflowState: 'internal',
  portalToken: 'secret',
};

const quotation: ModuleCap = {
  key: 'quotation',
  group: 'field_service',
  // "quote" and "quotes" (Increment 7, M21): read and written alike.
  labels: { singular: 'Quotation', plural: 'Quotations', synonyms: ['quotation', 'quotations', 'quote', 'quotes'] },
  gate: { flagKey: 'fs_quotations', permPrefix: 'fs.quotations', scopeKey: 'quotations' },
  model: () => NativeQuotation,
  // No unique index on quotationId: two quotations can share a number.
  ids: { business: 'quotationId', businessUnique: false, title: ['title'] },
  stage: { field: 'status', pipeline: 'quotation' },
  dates: { default: 'createdAt', created: 'createdAt', due: 'validUntil' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('status', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'quotation' } }),
    f('quotationId', 'Quotation ID', 'id', 'list', col(2)),
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ...business('customer', 'customerId') }),
    // The grand total (after discount and GST), the module's main amount.
    f('servicesAmountWithTax', 'Total', 'money', 'list', { ...col(2), ...branchMoney }),
    // A date picker's value (UTC midnight), read as Daily Events reads it.
    f('validUntil', 'Valid until', 'date', 'list', { ...col(3), dateRule: 'date' }),
    f('contractId', 'Contract', 'ref', 'detail', business('contract', 'contractId')),
    f('siteId', 'Site', 'ref', 'detail', business('site', 'siteId')),
    f('staffId', 'Staff', 'ref', 'detail', business('staff', 'staffId')),
    f('teamId', 'Team', 'ref', 'detail', business('team', 'teamId')),
    // Services and parts after the discount, before GST.
    f('servicesAmount', 'Subtotal', 'money', 'detail', branchMoney),
    f('partsAmount', 'Parts amount', 'money', 'detail', branchMoney),
    // Both are percentages (quotation.service.ts computes the totals from them).
    f('discount', 'Discount', 'percent', 'detail'),
    f('gstPercentage', 'GST', 'percent', 'detail'),
    f('services', 'Services', 'line_items', 'detail'),
    f('parts', 'Parts', 'line_items', 'detail'),
    created('detail'),
    updated(),
  ],
  ignoredPaths: { ...BASE, ...LOCKS, ...DOCUMENT_TEXT },
  routes: ROUTE_TEMPLATES.quotation,
};

const contract: ModuleCap = {
  key: 'contract',
  group: 'field_service',
  labels: { singular: 'Contract', plural: 'Contracts', synonyms: ['contract', 'contracts'] },
  gate: { flagKey: 'fs_contracts', permPrefix: 'fs.contracts', scopeKey: 'contracts' },
  model: () => NativeContract,
  ids: { business: 'contractId', businessUnique: false, title: ['title'] },
  stage: { field: 'status', pipeline: 'contract' },
  dates: { default: 'startDate', created: 'createdAt', due: 'endDate', start: 'startDate', end: 'endDate' },
  // Contracts are scoped by their assigned staff (staffIds), not by who created them.
  mine: { kind: 'staff_array', field: 'staffIds' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('title', 'Title', 'text', 'list', col(1)),
    f('status', 'Status', 'stage', 'list', { ...col(1), enumFrom: { pipeline: 'contract' } }),
    f('contractId', 'Contract ID', 'id', 'list', col(2)),
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ...business('customer', 'customerId') }),
    // The form's date is stored at 23:59:59.999 UTC on the picked day
    // (contract.service.ts). Cards and tables show that day (endOfDayUtc), as
    // the contract form does. Windows ("expiring this month") read it with the
    // 'date' rule, as Daily Events does: the next day for a tenant east of UTC.
    f('endDate', 'End', 'date', 'list', { ...col(2), dateRule: 'date', endOfDayUtc: true }),
    f('servicesAmountWithTax', 'Total', 'money', 'list', { ...col(3), ...branchMoney }),
    // A moment from the form's date and time; the screens show its date only.
    f('startDate', 'Start', 'date', 'detail', { dateRule: 'date' }),
    // The form still stores an end date (start + 1 year) when this is set.
    f('noEndDate', 'No end date', 'boolean', 'detail'),
    f('contractType', 'Type', 'enum', 'detail', fromSchema),
    f('priority', 'Priority', 'enum', 'detail', fromSchema),
    f('quotationId', 'Quotation', 'ref', 'detail', business('quotation', 'quotationId')),
    f('siteId', 'Site', 'ref', 'detail', business('site', 'siteId')),
    f('teamId', 'Team', 'ref', 'detail', business('team', 'teamId')),
    f('staffIds', 'Assigned staff', 'ref_many', 'detail', business('staff', 'staffId')),
    f('renewalType', 'Renewal', 'enum', 'detail', fromSchema),
    f('woGenerationMode', 'Work order generation', 'enum', 'detail', fromSchema),
    f('servicesAmount', 'Subtotal', 'money', 'detail', branchMoney),
    f('partsAmount', 'Parts amount', 'money', 'detail', branchMoney),
    f('discount', 'Discount', 'percent', 'detail'),
    f('gstPercentage', 'GST', 'percent', 'detail'),
    f('services', 'Services', 'line_items', 'detail'),
    f('parts', 'Parts', 'line_items', 'detail'),
    created('detail'),
    updated(),
    // The first assigned staff member (the form writes staffIds[0] here too).
    f('staffId', 'Lead staff', 'ref', 'hidden', business('staff', 'staffId')),
  ],
  ignoredPaths: {
    ...BASE, ...LOCKS, ...DOCUMENT_TEXT,
    // The visit schedule and its settings are shown on the contract's own page only.
    visits: 'detail_only', renewBeforeDays: 'detail_only', woLeadDays: 'detail_only',
    // The old recurring scheduler's bookkeeping.
    serviceFrequency: 'internal', recurringUnit: 'internal', recurringInterval: 'internal',
    nextServiceDate: 'internal', lastServiceDate: 'internal', autoWoGenerated: 'internal',
  },
  routes: ROUTE_TEMPLATES.contract,
};

const receipt: ModuleCap = {
  key: 'receipt',
  group: 'field_service',
  labels: { singular: 'Receipt', plural: 'Receipts', synonyms: ['receipt', 'receipts'] },
  gate: { flagKey: 'fs_receipts', permPrefix: 'fs.receipts', scopeKey: 'receipts' },
  model: () => NativeReceipt,
  // receipt.model.ts has a unique index on { tenantId, receiptId }.
  ids: { business: 'receiptId', businessUnique: true, title: ['receiptId'] },
  // A fixed schema status, not a pipeline. Completed and refunded receipts are
  // finished, so "open" receipts are the pending ones.
  stage: { field: 'status', enumFrom: 'schema', terminal: ['completed', 'refunded'] },
  dates: { default: 'paymentDate', created: 'createdAt' },
  mine: { kind: 'created_by' },
  search: { delegateToList: true, escapeAtCallSite: true },
  sort: { default: { by: 'createdAt', dir: 'desc' }, listSortable: [] },
  fields: [
    f('receiptId', 'Receipt', 'id', 'list', col(1)),
    f('status', 'Status', 'enum', 'list', { ...col(1), ...fromSchema }),
    f('customerId', 'Customer', 'ref', 'list', { ...col(2), ...business('customer', 'customerId') }),
    f('amount', 'Amount', 'money', 'list', { ...col(2), ...branchMoney }),
    // Optional on the Receipts form, with no default: a window on it says how
    // many receipts it leaves out for having none (undatedNotice).
    f('paymentDate', 'Payment date', 'date', 'list', { ...col(2), dateRule: 'date', undatedNotice: true }),
    // The invoice's number; an older receipt may hold the invoice's _id instead.
    f('invoiceId', 'Invoice', 'ref', 'list', { ...col(3), ...business('invoice', 'invoiceId') }),
    f('paymentMethod', 'Payment method', 'enum', 'detail', fromSchema),
    created('detail'),
    updated(),
  ],
  ignoredPaths: { ...BASE, notes: 'detail_only', idempotencyKey: 'system', requestHash: 'system' },
  routes: ROUTE_TEMPLATES.receipt,
};

/** Field Service documents, read only (sidebar group "Field Service"). */
export const FS_DOCUMENT_CAPS: readonly ModuleCap[] = [quotation, contract, receipt];
