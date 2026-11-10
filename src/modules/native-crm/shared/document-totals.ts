/** Money totals of Field Service documents, moved verbatim from
 * invoice.service.ts (createInvoice, updateInvoice) and quotation.service.ts
 * (createQuotation, updateQuotation). Results must stay byte-identical:
 * backend/tests/document-totals-golden.test.ts pins them. Do not simplify
 * an expression: algebraically equal forms round differently. */
export type DocumentTotalsKind = 'invoice' | 'quotation';

export interface DocumentTotalsInput {
  services: unknown;        // create: data.services; update: data.services ?? existing?.services
  parts: unknown;           // likewise
  discount: unknown;        // percent; create: data.discount; update: data.discount ?? existing?.discount
  gstPercentage: unknown;   // percent; likewise
}

export interface DocumentTotals {
  /** header: no line has its own rate; line: a 0/0 header with rated lines;
   * mixed (LR-R26-CTR-007): a header rate and rated lines. */
  mode: 'header' | 'line' | 'mixed';
  partsAmount: number;              // never rounded
  servicesAmount: number;           // invoice: Math.round to cents; quotation: unrounded
  servicesAmountWithTax: number;    // invoice: Math.round to cents; quotation: unrounded
  /** Invoice line mode only: header values written back when every service line shares the rate. */
  backfill: { discount?: number; gstPercentage?: number };
  /** Not written: services + parts before discount (the view pages' Subtotal), for review cards. */
  linesGross: number;
  rounded: boolean;
}

/** LR-R26-CTR-007: the discount and tax that apply to one line. A line's own
 * rate (above 0) replaces the header's for that line; a line without one uses
 * the header's. They never stack. Contracts, their visits, work orders and
 * invoices all use this rule. */
export function effectiveLineRates(
  line: { discountPercent?: unknown; taxPercent?: unknown } | null | undefined,
  header: { discount?: unknown; gstPercentage?: unknown },
): { discountPercent: number; taxPercent: number } {
  const own = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
  return {
    discountPercent: own(line?.discountPercent) ?? (Number(header.discount) || 0),
    taxPercent:      own(line?.taxPercent)      ?? (Number(header.gstPercentage) || 0),
  };
}

/** LR-R26-CTR-007: services at their effective rates (effectiveLineRates)
 * plus parts at the header's, unrounded. */
export function totalsWithLineRates(
  services: any[], parts: any[], header: { discount?: unknown; gstPercentage?: unknown },
): { gross: number; afterDiscount: number; withTax: number; partsAmount: number } {
  const discount = Number(header.discount) || 0;
  const gst      = Number(header.gstPercentage) || 0;
  let gross = 0;
  let afterDiscount = 0;
  let withTax = 0;
  for (const s of services) {
    const g = (Number(s?.amount) || 0) * (Number(s?.count) || 1);
    const r = effectiveLineRates(s, header);
    const afterD = g * (1 - r.discountPercent / 100);
    gross += g;
    afterDiscount += afterD;
    withTax += afterD * (1 + r.taxPercent / 100);
  }
  const partsAmount = parts.reduce((sum: number, p: any) => sum + (Number(p?.amount) || 0) * (Number(p?.count) || 1), 0);
  const partsAfter = partsAmount - (partsAmount * discount) / 100;
  gross += partsAmount;
  afterDiscount += partsAfter;
  withTax += partsAfter + (partsAfter * gst) / 100;
  return { gross, afterDiscount, withTax, partsAmount };
}

export function computeDocumentTotals(kind: DocumentTotalsKind, input: DocumentTotalsInput): DocumentTotals {
  const services: any[] = (input.services as any) ?? [];
  const parts: any[]    = (input.parts as any) ?? [];
  const svcTotal = services.reduce((sum: number, s: any) => sum + (Number(s.amount) * Number(s.count || 1)), 0);
  const prtTotal = parts.reduce((sum: number, p: any) => sum + (Number(p.amount) * Number(p.count || 1)), 0);
  const discount = Number(input.discount ?? 0);
  const gst      = Number(input.gstPercentage ?? 0);

  if (kind === 'quotation') {
    // discount is a percentage (0-100), not a flat amount.
    const subtotal = svcTotal + prtTotal;
    const after    = subtotal - (subtotal * discount) / 100;
    return { mode: 'header', partsAmount: prtTotal, servicesAmount: after, servicesAmountWithTax: after + (after * gst) / 100,
             backfill: {}, linesGross: subtotal, rounded: false };
  }

  const hasLineTaxOrDisc = services.some((s: any) => (Number(s.taxPercent) > 0 || Number(s.discountPercent) > 0));
  if (discount === 0 && gst === 0 && hasLineTaxOrDisc) {
    let lineAfter = 0;
    let lineWithTax = 0;
    for (const s of services) {
      const gross = (Number(s.amount) || 0) * (Number(s.count) || 1);
      const afterD = gross * (1 - (Number(s.discountPercent) || 0) / 100);
      const withT = afterD * (1 + (Number(s.taxPercent) || 0) / 100);
      lineAfter += afterD;
      lineWithTax += withT;
    }
    const backfill: DocumentTotals['backfill'] = {};
    const firstDisc = Number(services[0]?.discountPercent || 0);
    const firstTax  = Number(services[0]?.taxPercent || 0);
    if (services.every((s: any) => Number(s.discountPercent || 0) === firstDisc)) backfill.discount = firstDisc;
    if (services.every((s: any) => Number(s.taxPercent || 0) === firstTax)) backfill.gstPercentage = firstTax;
    return { mode: 'line', partsAmount: prtTotal,
             servicesAmount: Math.round((lineAfter + prtTotal) * 100) / 100,
             servicesAmountWithTax: Math.round((lineWithTax + prtTotal) * 100) / 100,
             backfill, linesGross: svcTotal + prtTotal, rounded: true };
  }
  if (hasLineTaxOrDisc) {
    // LR-R26-CTR-007: a header rate and lines with their own: each line at its
    // own rate, else the header's; parts at the header's. Before, any header
    // rate dropped every line's own (line discount 10 + header GST 18 stored
    // 1,000 + 18 % = 1,180 instead of 900 + 18 % = 1,062).
    const m = totalsWithLineRates(services, parts, { discount, gstPercentage: gst });
    return { mode: 'mixed', partsAmount: prtTotal,
             servicesAmount: Math.round(m.afterDiscount * 100) / 100,
             servicesAmountWithTax: Math.round(m.withTax * 100) / 100,
             backfill: {}, linesGross: svcTotal + prtTotal, rounded: true };
  }
  // discount is a percentage (0-100), not a flat amount.
  const subtotal = svcTotal + prtTotal;
  const after    = subtotal - (subtotal * discount) / 100;
  return { mode: 'header', partsAmount: prtTotal,
           servicesAmount: Math.round(after * 100) / 100,
           servicesAmountWithTax: Math.round((after + (after * gst) / 100) * 100) / 100,
           backfill: {}, linesGross: subtotal, rounded: true };
}

/** What the list and view pages print for a stored amount: Number(v).toFixed(2). */
export function screenCents(v: number): number { return Number(Number(v).toFixed(2)); }
