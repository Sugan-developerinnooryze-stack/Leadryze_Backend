import { computeDocumentTotals, totalsWithLineRates } from '../shared/document-totals';

/* LR-R26-PDF-002: the money a PDF prints, in one place for the built-in
 * templates (pdf.templates.ts totalsHtml) and the designer's totals rows
 * (variable-catalog.ts totalsValue), so the two cannot disagree. The designer
 * rows used the header rates for every line, which the built-in templates
 * stopped doing for LR-R26-CTR-007, and printed Paid / Balance Due as all or
 * nothing.
 *
 * Invoices print their saved totals (servicesAmount, servicesAmountWithTax),
 * as the invoice page does and as the receipts and the balanceDue virtual
 * compare against; an invoice without them gets what the invoice service
 * would save (computeDocumentTotals, rounded to the cent). Other documents
 * are worked out from their lines, as before: with no line rates, the header
 * discount (a percentage) and GST for everything; when lines have their own
 * discount or tax, each line at its own rate, else the header's, and parts at
 * the header's, rounded to the cent (LR-R26-CTR-007). Quotations
 * ('quotation') keep the header-only sum their service stores. A work order
 * stores no total, so it always gets the worked-out one. */

export type PdfMoneyKind = 'invoice' | 'quotation' | 'other';

export interface PdfMoney {
  servicesSubtotal: number;
  partsSubtotal:    number;
  subtotal:         number;   // services + parts, before discount
  discount:         number;   // the discount amount
  afterDiscount:    number;
  total:            number;
  lineRates:        boolean;  // some line has its own discount or tax
  saved:            boolean;  // an invoice's saved (or would-be saved) totals
  discountPercent:  number;   // the header's
  gstPercent:       number;   // the header's
}

const finite = (v: unknown): number | undefined =>
  (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function pdfMoney(doc: any, kind: PdfMoneyKind = 'other'): PdfMoney {
  const services = doc?.services ?? [];
  const parts    = doc?.parts    ?? [];
  const servicesSubtotal = services.reduce((s: number, x: any) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const partsSubtotal    = parts.reduce((s: number, x: any) => s + (x.amount ?? 0) * (x.count ?? 1), 0);
  const discountPercent = doc?.discount      ?? 0;
  const gstPercent      = doc?.gstPercentage ?? 0;
  const subtotal = servicesSubtotal + partsSubtotal;
  const lineRates = kind !== 'quotation' && services.some((s: any) => Number(s.taxPercent) > 0 || Number(s.discountPercent) > 0);
  const base = { servicesSubtotal, partsSubtotal, subtotal, lineRates, discountPercent, gstPercent };

  if (kind === 'invoice') {
    let afterDiscount = finite(doc?.servicesAmount);
    let total = finite(doc?.servicesAmountWithTax);
    if (afterDiscount === undefined || total === undefined) {
      const t = computeDocumentTotals('invoice', { services, parts, discount: doc?.discount, gstPercentage: doc?.gstPercentage });
      afterDiscount ??= t.servicesAmount;
      total ??= t.servicesAmountWithTax;
    }
    return { ...base, discount: subtotal - afterDiscount, afterDiscount, total, saved: true };
  }
  if (lineRates) {
    const m = totalsWithLineRates(services, parts, { discount: discountPercent, gstPercentage: gstPercent });
    const afterDiscount = Math.round(m.afterDiscount * 100) / 100;
    const total         = Math.round(m.withTax * 100) / 100;
    return { ...base, discount: subtotal - afterDiscount, afterDiscount, total, saved: false };
  }
  const discount = subtotal * (discountPercent / 100);
  const afterDiscount = subtotal - discount;
  const total = afterDiscount + afterDiscount * (gstPercent / 100);
  return { ...base, discount, afterDiscount, total, saved: false };
}

export interface InvoicePayment {
  paid:       number;   // the receipts (paidAmount, refreshed by getInvoiceById)
  balance:    number;   // the total minus what was paid, never below 0
  paidStage:  boolean;  // the status is the tenant's paid stage
  settled:    boolean;  // paid stage, marked paid, or nothing left to pay
  /** For a template's Paid / Balance Due rows: the receipts when there are
   * any; with none, all of it when the invoice is settled (marked paid), none
   * when it is not. */
  rowPaid:    number;
  rowBalance: number;
}

/** What has been paid on an invoice and what is left, as the invoice page and
 * the balanceDue virtual show them: the receipts, and the saved total minus
 * the receipts. paidKey is the tenant's stage tagged 'paid' (it can be
 * renamed); 'paid' when unknown. */
export function invoicePayment(doc: any, total: number, paidKey?: string): InvoicePayment {
  const paid = Math.max(0, Number(doc?.paidAmount) || 0);
  const balance = Math.max(0, Math.round((total - paid) * 100) / 100);
  const paidStage = doc?.status != null && doc.status === (paidKey ?? 'paid');
  const settled = paidStage || doc?.paid === true || (paid > 0 && balance === 0);
  const noReceipts = paid === 0;
  return {
    paid, balance, paidStage, settled,
    rowPaid:    noReceipts ? (settled ? total : 0) : paid,
    rowBalance: noReceipts ? (settled ? 0 : total) : balance,
  };
}
