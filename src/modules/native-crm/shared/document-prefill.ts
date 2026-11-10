/** The server's copy of the screens' conversion prefill,
 * frontend/src/modules/native-crm/shared/buildPrefill.ts, ported line for
 * line: the same keys, fallback chains and references, so a document the
 * assistant makes from another one carries exactly what the screen's
 * convert button carries. backend/tests/document-prefill.test.ts pins the
 * outputs and a hash of buildPrefill.ts: when that file changes, the test
 * fails until this port follows it. Pure, no imports. */

export type DocType = 'quotation' | 'contract' | 'workorder' | 'invoice';

// Which ancestor-reference fields each document type's model supports
// (native-crm quotations, contracts, workorders and invoices *.model.ts).
const SUPPORTED_REFS: Record<DocType, DocType[]> = {
  quotation: ['contract'],
  contract:  ['quotation'],
  workorder: ['contract', 'quotation'],
  invoice:   ['contract', 'quotation', 'workorder'],
};

// A document's own business-id field is also the field other documents use
// to reference it, so `source[REF_FIELD[t]]` reads both directions.
const REF_FIELD: Record<DocType, string> = {
  quotation: 'quotationId',
  contract:  'contractId',
  workorder: 'workOrderId',
  invoice:   'invoiceId',
};

// Site, staff and team exist on quotations, contracts and work orders; an
// invoice has none of the three.
const SUPPORTS_SITE_STAFF_TEAM: Record<DocType, boolean> = {
  quotation: true, contract: true, workorder: true, invoice: false,
};

/** The prefill of a new `to` document made from a `source` of type `from`
 * (any of the 12 pairs): customer, address, services, parts, discount, tax,
 * notes and title always; site, staff and team when `to` has them; the
 * ancestor references: the direct link to the source, plus each of the
 * source's own references that `to` also has room for. */
export function buildDocumentPrefill(source: any, from: DocType, to: DocType): Record<string, any> {
  const out: Record<string, any> = {
    customerId:    source.customerId,
    address:       source.address       ?? '',
    services:      source.services      ?? [],
    parts:         source.parts         ?? [],
    discount:      source.discount ?? source.services?.find((s: any) => s.discountPercent != null)?.discountPercent ?? 0,
    gstPercentage: source.gstPercentage ?? source.services?.find((s: any) => s.taxPercent != null)?.taxPercent ?? 0,
    notes:         source.notes         ?? '',
    title: from === 'contract' && to === 'workorder'
      ? `Service Visit — ${source.title ?? ''}`
      : (source.title ?? ''),
  };

  if (SUPPORTS_SITE_STAFF_TEAM[to]) {
    out.siteId  = source.siteId  ?? '';
    out.staffId = source.staffId ?? '';
    out.teamId  = source.teamId  ?? '';
  }

  for (const ancestorType of SUPPORTED_REFS[to]) {
    const field = REF_FIELD[ancestorType];
    if (ancestorType === from) {
      out[field] = source[field]; // direct link to the source itself
    } else if (SUPPORTED_REFS[from]?.includes(ancestorType)) {
      out[field] = source[field]; // inherited from the source's own ancestor reference
    }
  }

  return out;
}

/** What an invoice create takes from a work order, as the screen's convert sends it after the screen's Zod:
 * customerId, address, services, parts, discount, gstPercentage, notes, workOrderId and, when present,
 * quotationId and contractId (title dropped as Zod drops it; an undefined ref left out as FSDrawer's
 * passthrough leaves it out). */
export function workorderToInvoicePrefill(wo: Record<string, unknown>): Record<string, unknown> {
  const p = buildDocumentPrefill(wo, 'workorder', 'invoice');
  const out: Record<string, unknown> = {
    customerId:    p.customerId,
    address:       p.address,
    services:      p.services,
    parts:         p.parts,
    discount:      p.discount,
    gstPercentage: p.gstPercentage,
    notes:         p.notes,
    workOrderId:   p.workOrderId,
  };
  // The invoice form has no field for these two, so only FSDrawer's create passthrough sends them,
  // and it skips a key that is undefined or null.
  if (p.quotationId != null) out.quotationId = p.quotationId;
  if (p.contractId != null) out.contractId = p.contractId;
  return out;
}
