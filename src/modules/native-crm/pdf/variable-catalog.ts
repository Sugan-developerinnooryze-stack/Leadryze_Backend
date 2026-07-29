import { ICustomFieldDoc } from '../custom-fields/custom-field.model';
import { ITableColumn, TemplateDocType, TotalsRowKey } from '../custom-templates/custom-template.model';

/**
 * Single source of truth for every variable the PDF template designer can
 * offer and the renderer can resolve. The designer palette is served from
 * VARIABLE_CATALOG via GET /custom-templates/catalog; the renderer resolves
 * values via RESOLVERS. Keeping both here means they can never drift.
 */

export interface CatalogEntry {
  key:      string;   // 'company.name', 'invoice.dueDate', 'custom.<fieldKey>'
  label:    string;
  group:    string;
  elemType: 'text' | 'image' | 'richtext' | 'table' | 'totals';
  docTypes: TemplateDocType[] | 'all';
}

export interface RenderCtx {
  doc:             any;
  settings:        any;   // FSSettings (tenant/branch)
  customer:        any;   // NativeCustomer | null
  docType:         TemplateDocType;
  cur:             string;
  customFieldDefs: Pick<ICustomFieldDoc, 'fieldKey' | 'label' | 'fieldType'>[];
  // Assigned site/staff/team, looked up by human code (contract/workorder only).
  site?:  { name?: string } | null;
  staff?: { firstName?: string; lastName?: string } | null;
  team?:  { name?: string } | null;
  // invoice.status is tenant-configurable — this is the tenant's own stage key
  // currently tagged with the 'paid' outcome (resolved once per render by the
  // caller), so a rename can't make a paid invoice's PDF show "Balance Due".
  // Falls back to the literal 'paid' when not supplied (e.g. legacy callers).
  invoicePaidKey?: string;
}

// The custom-fields module keys documents by PLURAL module strings ('invoices')
// while templates use singular docTypes — this map is the one place that
// translation lives (Phase-4 custom-module docTypes will extend it).
export const MODULE_FOR_DOCTYPE: Record<TemplateDocType, string> = {
  invoice:   'invoices',
  quotation: 'quotations',
  contract:  'contracts',
  workorder: 'workorders',
};

const CUR_SYMBOL: Record<string, string> = {
  AUD:'$', USD:'$', GBP:'£', EUR:'€', INR:'₹', CAD:'$', NZD:'$', SGD:'$',
};

export function currencySymbol(currency?: string): string {
  return CUR_SYMBOL[currency ?? 'AUD'] ?? '$';
}

export function esc(s: any): string {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function fmtDate(d: any): string {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMoney(n: any, cur: string): string {
  return `${cur}${Number(n ?? 0).toFixed(2)}`;
}

function companyAddress(s: any): string {
  return [s?.address1, s?.address2, s?.city, s?.state, s?.postalCode, s?.country]
    .filter(Boolean).join(', ');
}

function customerAddress(c: any): string {
  return [c?.address, c?.city, c?.state, c?.postcode, c?.country]
    .filter(Boolean).join(', ');
}

function staffFullName(s?: { firstName?: string; lastName?: string } | null): string {
  return [s?.firstName, s?.lastName].filter(Boolean).join(' ');
}

const FOOTER_FIELD: Record<TemplateDocType, string> = {
  invoice:   'invoiceFooter',
  quotation: 'quotationFooter',
  contract:  'contractFooter',
  workorder: 'workorderFooter',
};

// ─── Catalog (what the designer palette shows) ────────────────────────────────

export const VARIABLE_CATALOG: CatalogEntry[] = [
  // Company
  { key: 'company.name',    label: 'Company Name',   group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.logo',    label: 'Company Logo',   group: 'Company', elemType: 'image', docTypes: 'all' },
  { key: 'company.address', label: 'Address',        group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.gstin',   label: 'GSTIN / Tax ID', group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.pan',     label: 'PAN',            group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.businessRegNumber', label: 'Business Reg. No.', group: 'Company', elemType: 'text', docTypes: 'all' },
  { key: 'company.email',   label: 'Email',          group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.phone',   label: 'Phone',          group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.whatsapp',label: 'WhatsApp',       group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.website', label: 'Website',        group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.branch',  label: 'Branch',         group: 'Company', elemType: 'text',  docTypes: 'all' },
  { key: 'company.signature', label: 'Signature',    group: 'Company', elemType: 'image', docTypes: 'all' },
  { key: 'company.stamp',   label: 'Stamp',          group: 'Company', elemType: 'image', docTypes: 'all' },
  // Bank
  { key: 'bank.name',        label: 'Bank Name',      group: 'Bank Details', elemType: 'text',  docTypes: 'all' },
  { key: 'bank.accountName', label: 'Account Name',   group: 'Bank Details', elemType: 'text',  docTypes: 'all' },
  { key: 'bank.account',     label: 'Account Number', group: 'Bank Details', elemType: 'text',  docTypes: 'all' },
  { key: 'bank.ifsc',        label: 'BSB / IFSC',     group: 'Bank Details', elemType: 'text',  docTypes: 'all' },
  { key: 'bank.upi',         label: 'UPI ID',         group: 'Bank Details', elemType: 'text',  docTypes: 'all' },
  { key: 'bank.qr',          label: 'Payment QR',     group: 'Bank Details', elemType: 'image', docTypes: 'all' },
  // Customer
  { key: 'customer.name',            label: 'Customer Name',     group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.email',           label: 'Email',             group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.phone',           label: 'Phone',             group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.address',         label: 'Address',           group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.company',         label: 'Company',           group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.designation',     label: 'Designation',       group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.billingName',     label: 'Billing Name',      group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.billingAddress',  label: 'Billing Address',   group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.deliveryAddress', label: 'Delivery Address',  group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.addEmails',       label: 'Additional Emails', group: 'Customer', elemType: 'text', docTypes: 'all' },
  { key: 'customer.addPhones',       label: 'Additional Phones', group: 'Customer', elemType: 'text', docTypes: 'all' },
  // Document — common
  { key: 'doc.id',       label: 'Document ID', group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.date',     label: 'Date',        group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.status',   label: 'Status',      group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.subtotal', label: 'Subtotal',    group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.discount', label: 'Discount',    group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.gst',      label: 'GST Rate',    group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.total',    label: 'Total',       group: 'Document', elemType: 'text',     docTypes: 'all' },
  { key: 'doc.amountPaid', label: 'Amount Paid',  group: 'Document', elemType: 'text',  docTypes: 'all' },
  { key: 'doc.balanceDue', label: 'Balance Due',  group: 'Document', elemType: 'text',  docTypes: 'all' },
  { key: 'doc.notes',    label: 'Notes (rich text)', group: 'Document', elemType: 'richtext', docTypes: 'all' },
  { key: 'doc.terms',    label: 'Terms & Conditions (rich text)', group: 'Document', elemType: 'richtext', docTypes: 'all' },
  { key: 'doc.footer',   label: 'Footer Text', group: 'Document', elemType: 'text',     docTypes: 'all' },
  // Per-docType
  { key: 'invoice.dueDate',     label: 'Due Date',        group: 'Invoice',    elemType: 'text', docTypes: ['invoice'] },
  { key: 'invoice.paid',        label: 'Paid (Yes/No)',   group: 'Invoice',    elemType: 'text', docTypes: ['invoice'] },
  { key: 'invoice.workOrderId', label: 'Work Order Ref',  group: 'Invoice',    elemType: 'text', docTypes: ['invoice'] },
  { key: 'quotation.validUntil',label: 'Valid Until',     group: 'Quotation',  elemType: 'text', docTypes: ['quotation'] },
  { key: 'quotation.title',     label: 'Subject / Title', group: 'Quotation',  elemType: 'text', docTypes: ['quotation'] },
  { key: 'contract.startDate',  label: 'Start Date',      group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.endDate',    label: 'End Date',        group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.serviceFrequency', label: 'Service Frequency', group: 'Contract', elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.quotationId',label: 'Quotation Ref',   group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.title',      label: 'Contract Title',  group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.siteName',   label: 'Site Name',       group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.staffName',  label: 'Assigned Staff',  group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'contract.teamName',   label: 'Assigned Team',   group: 'Contract',   elemType: 'text', docTypes: ['contract'] },
  { key: 'workorder.scheduledDate', label: 'Scheduled Date', group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.completedDate', label: 'Completed Date', group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.priority',      label: 'Priority',       group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.title',         label: 'Work Description', group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.siteName',      label: 'Site Name',      group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.staffName',     label: 'Assigned Staff', group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  { key: 'workorder.teamName',      label: 'Assigned Team',  group: 'Work Order', elemType: 'text', docTypes: ['workorder'] },
  // Tables & totals
  { key: 'services.table', label: 'Services Table',       group: 'Tables', elemType: 'table',  docTypes: 'all' },
  { key: 'parts.table',    label: 'Parts Table',          group: 'Tables', elemType: 'table',  docTypes: 'all' },
  { key: 'totals.block',   label: 'Totals Block',         group: 'Tables', elemType: 'totals', docTypes: 'all' },
];

// ─── Resolvers (how the renderer turns keys into values) ─────────────────────
// Text resolvers return HTML-escaped strings; image keys return raw URLs.

export const RESOLVERS: Record<string, (ctx: RenderCtx) => string> = {
  'company.name':    (c) => esc(c.settings?.companyName),
  'company.logo':    (c) => c.settings?.companyLogo ?? '',
  'company.address': (c) => esc(companyAddress(c.settings)),
  'company.gstin':   (c) => esc(c.settings?.gstin),
  'company.pan':     (c) => esc(c.settings?.pan),
  'company.businessRegNumber': (c) => esc(c.settings?.businessRegNumber),
  'company.email':   (c) => esc(c.settings?.companyEmail),
  'company.phone':   (c) => esc(c.settings?.phone),
  'company.whatsapp':(c) => esc(c.settings?.whatsapp),
  'company.website': (c) => esc(c.settings?.website),
  'company.branch':  (c) => esc(c.settings?.branch),
  'company.signature': (c) => c.settings?.companySignature ?? '',
  'company.stamp':   (c) => c.settings?.stampImage ?? '',

  'bank.name':        (c) => esc(c.settings?.bankName),
  'bank.accountName': (c) => esc(c.settings?.accountName),
  'bank.account':     (c) => esc(c.settings?.accountNumber),
  'bank.ifsc':        (c) => esc(c.settings?.ifscCode),
  'bank.upi':         (c) => esc(c.settings?.upiId),
  'bank.qr':          (c) => c.settings?.qrCodeImage ?? '',

  'customer.name':            (c) => esc(c.customer?.name ?? c.doc?.customerId),
  'customer.email':           (c) => esc(c.customer?.email),
  'customer.phone':           (c) => esc(c.customer?.phone),
  'customer.address':         (c) => esc(customerAddress(c.customer)),
  'customer.company':         (c) => esc(c.customer?.company),
  'customer.designation':     (c) => esc(c.customer?.designation),
  'customer.billingName':     (c) => esc(c.customer?.billingName),
  'customer.billingAddress':  (c) => esc(c.customer?.billingAddress),
  'customer.deliveryAddress': (c) => esc(c.customer?.deliveryAddress),
  'customer.addEmails':       (c) => esc((c.customer?.addEmail ?? []).filter(Boolean).join(', ')),
  'customer.addPhones':       (c) => esc((c.customer?.addPhone ?? []).filter(Boolean).join(', ')),

  'doc.id':       (c) => esc(c.doc?.invoiceId ?? c.doc?.quotationId ?? c.doc?.contractId ?? c.doc?.workOrderId),
  'doc.date':     (c) => esc(fmtDate(c.doc?.createdAt)),
  // Superseded by the correctly docType-scoped 'invoice.dueDate' below —
  // resolver kept only so templates saved before that existed still render;
  // intentionally NOT in VARIABLE_CATALOG (adding it back would show two
  // confusingly-identical "Due Date" entries in the invoice palette).
  'doc.dueDate':  (c) => esc(fmtDate(c.doc?.dueDate ?? c.doc?.validUntil)),
  'doc.status':   (c) => esc(String(c.doc?.status ?? '').toUpperCase()),
  'doc.subtotal': (c) => esc(fmtMoney((c.doc?.servicesAmount ?? 0) + (c.doc?.discount ?? 0), c.cur)),
  'doc.discount': (c) => esc(fmtMoney(c.doc?.discount ?? 0, c.cur)),
  'doc.gst':      (c) => esc(`${c.doc?.gstPercentage ?? 0}%`),
  'doc.total':    (c) => esc(fmtMoney(c.doc?.servicesAmountWithTax ?? 0, c.cur)),
  'doc.amountPaid': (c) => esc(totalsValue('paid', c)),
  'doc.balanceDue': (c) => esc(totalsValue('balance', c)),
  'doc.footer':   (c) => esc(c.settings?.[FOOTER_FIELD[c.docType]]),
  // doc.notes / doc.terms are handled by the richtext element renderer (raw
  // sanitized HTML) — these plain-text fallbacks keep old text elements working.
  'doc.notes':    (c) => esc(String(c.doc?.notes ?? '').replace(/<[^>]+>/g, ' ').trim()),
  'doc.terms':    (c) => esc(String(c.doc?.termsAndConditions ?? '').replace(/<[^>]+>/g, ' ').trim()),

  'invoice.dueDate':     (c) => esc(fmtDate(c.doc?.dueDate)),
  'invoice.paid':        (c) => (c.doc?.paid || c.doc?.status === (c.invoicePaidKey ?? 'paid')) ? 'Yes' : 'No',
  'invoice.workOrderId': (c) => esc(c.doc?.workOrderId),
  'quotation.validUntil':(c) => esc(fmtDate(c.doc?.validUntil)),
  'quotation.title':     (c) => esc(c.doc?.title),
  'contract.startDate':  (c) => esc(fmtDate(c.doc?.startDate)),
  'contract.endDate':    (c) => esc(fmtDate(c.doc?.endDate)),
  'contract.serviceFrequency': (c) => esc(c.doc?.serviceFrequency),
  'contract.quotationId':(c) => esc(c.doc?.quotationId),
  'contract.title':      (c) => esc(c.doc?.title),
  'contract.siteName':   (c) => esc(c.site?.name),
  'contract.staffName':  (c) => esc(staffFullName(c.staff)),
  'contract.teamName':   (c) => esc(c.team?.name),
  'workorder.scheduledDate': (c) => esc(fmtDate(c.doc?.scheduledDate)),
  'workorder.completedDate': (c) => esc(fmtDate(c.doc?.completedDate)),
  'workorder.priority':      (c) => esc(c.doc?.priority),
  'workorder.title':         (c) => esc(c.doc?.title),
  'workorder.siteName':      (c) => esc(c.site?.name),
  'workorder.staffName':     (c) => esc(staffFullName(c.staff)),
  'workorder.teamName':      (c) => esc(c.team?.name),
};

/** Format a custom-field value by its declared field type. */
export function formatCustomFieldValue(val: any, fieldType: string, cur: string): string {
  if (val === null || val === undefined || val === '') return '';
  switch (fieldType) {
    case 'date':
    case 'datetime': return esc(fmtDate(val));
    case 'currency': return esc(fmtMoney(val, cur));
    case 'boolean':
    case 'checkbox': return val ? 'Yes' : 'No';
    case 'multi_select':
    case 'images':
    case 'videos':   return esc(Array.isArray(val) ? val.join(', ') : val);
    case 'rating':   return esc('★'.repeat(Math.max(0, Math.min(10, Number(val) || 0))));
    default:         return esc(typeof val === 'object' ? JSON.stringify(val) : val);
  }
}

/** Full var map for a render: static resolvers + per-tenant custom fields. */
export function buildVarMap(ctx: RenderCtx): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, resolve] of Object.entries(RESOLVERS)) {
    map[key] = resolve(ctx);
  }
  for (const def of ctx.customFieldDefs) {
    // image-type custom fields stay raw URLs so image elements can bind them
    const raw = ctx.doc?.customFields?.[def.fieldKey];
    map[`custom.${def.fieldKey}`] = def.fieldType === 'image'
      ? String(raw ?? '')
      : formatCustomFieldValue(raw, def.fieldType, ctx.cur);
  }
  return map;
}

/** Palette payload for the designer: static entries filtered by docType + custom fields. */
export function buildCatalogForDocType(
  docType: TemplateDocType,
  customFieldDefs: Pick<ICustomFieldDoc, 'fieldKey' | 'label' | 'fieldType'>[],
): { label: string; items: { key: string; label: string; elemType: string }[] }[] {
  const groups = new Map<string, { key: string; label: string; elemType: string }[]>();

  for (const entry of VARIABLE_CATALOG) {
    if (entry.docTypes !== 'all' && !entry.docTypes.includes(docType)) continue;
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group)!.push({ key: entry.key, label: entry.label, elemType: entry.elemType });
  }

  if (customFieldDefs.length) {
    groups.set('Custom Fields', customFieldDefs.map((d) => ({
      key:      `custom.${d.fieldKey}`,
      label:    d.label,
      elemType: d.fieldType === 'image' ? 'image' : 'text',
    })));
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

// ─── Table-cell / totals value helpers ────────────────────────────────────────
// Shared by the HTML renderer (pdf.variable-renderer.ts) and the live-data
// endpoint (pdf.controller.ts) so table/totals math is computed exactly once.

export const DEFAULT_SERVICE_COLUMNS: ITableColumn[] = [
  { key: 'index',       label: '#',          width: 6,  align: 'left'  },
  { key: 'name',        label: 'Description',            align: 'left'  },
  { key: 'count',       label: 'Qty',        width: 10, align: 'right' },
  { key: 'amount',      label: 'Unit Price', width: 10, align: 'right' },
  { key: 'lineTotal',   label: 'Amount',     width: 10, align: 'right' },
];

export const DEFAULT_PART_COLUMNS: ITableColumn[] = [
  { key: 'index',      label: '#',          width: 6,  align: 'left'  },
  { key: 'name',       label: 'Part Name',              align: 'left'  },
  { key: 'partNumber', label: 'Part No.',   width: 10, align: 'left'  },
  { key: 'count',      label: 'Qty',        width: 10, align: 'right' },
  { key: 'amount',     label: 'Unit Price', width: 10, align: 'right' },
  { key: 'lineTotal',  label: 'Amount',     width: 10, align: 'right' },
];

export function cellValue(row: any, key: string, index: number, cur: string): string {
  switch (key) {
    case 'index':       return String(index + 1);
    case 'name':        return `<b>${esc(row.name)}</b>${row.description ? `<br><span style="color:#9ca3af;font-size:0.85em">${esc(row.description)}</span>` : ''}`;
    case 'description': return esc(row.description);
    case 'partNumber':  return esc(row.partNumber ?? '—');
    case 'count':       return String(row.count ?? 1);
    case 'amount':      return esc(fmtMoney(row.amount, cur));
    case 'lineTotal':   return `<b>${esc(fmtMoney((row.amount ?? 0) * (row.count ?? 1), cur))}</b>`;
    default:            return '';
  }
}

export const DEFAULT_TOTALS_ROWS: { key: TotalsRowKey; label?: string }[] = [
  { key: 'subtotal' }, { key: 'discount' }, { key: 'gst' }, { key: 'total' },
];

export const TOTALS_LABELS: Record<TotalsRowKey, string> = {
  servicesSubtotal: 'Services',
  partsSubtotal:    'Parts',
  subtotal:         'Subtotal',
  discount:         'Discount',
  gst:              'GST',
  total:            'TOTAL',
  paid:             'Paid',
  balance:          'Balance Due',
};

export function totalsValue(key: TotalsRowKey, ctx: RenderCtx): string {
  const d = ctx.doc ?? {};
  const svc = (d.services ?? []).reduce((s: number, x: any) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const prt = (d.parts    ?? []).reduce((s: number, x: any) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const discount = d.discount ?? 0;
  const gstPct = d.gstPercentage ?? 0;
  const afterDiscount = svc + prt - discount;
  // Derived fully from services/parts/discount/gst rather than trusting a
  // persisted servicesAmountWithTax field — identical result for docTypes
  // that do store one (invoice/quotation/contract keep them in sync, see
  // invoice.service.ts), and the only way workorder (which has no such
  // persisted field) can ever show a nonzero total at all.
  const total = afterDiscount + afterDiscount * (gstPct / 100);
  switch (key) {
    case 'servicesSubtotal': return fmtMoney(svc, ctx.cur);
    case 'partsSubtotal':    return fmtMoney(prt, ctx.cur);
    case 'subtotal':         return fmtMoney(svc + prt, ctx.cur);
    case 'discount':         return discount > 0 ? `-${fmtMoney(discount, ctx.cur)}` : fmtMoney(0, ctx.cur);
    case 'gst':              return `${gstPct}% · ${fmtMoney(afterDiscount * (gstPct / 100), ctx.cur)}`;
    case 'total':            return fmtMoney(total, ctx.cur);
    case 'paid':             return fmtMoney((d.paid || d.status === (ctx.invoicePaidKey ?? 'paid')) ? total : 0, ctx.cur);
    case 'balance':          return fmtMoney((d.paid || d.status === (ctx.invoicePaidKey ?? 'paid')) ? 0 : total, ctx.cur);
  }
}
