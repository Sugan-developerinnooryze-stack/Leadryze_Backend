import { IDesignElement, ITemplatePage, TemplateDocType } from './custom-template.model';

/**
 * "Classic (Starter)" designer templates — the classic hardcoded layout
 * hand-converted to element JSON so every tenant starts from something
 * editable in the PDF Designer instead of a blank canvas.
 *
 * Layout is band-model friendly: header/bill-to elements sit fully above the
 * services table; tables and rich-text render as flow blocks; totals, bank,
 * footer and signatures sit below all flow blocks (footer band).
 */

const DOC_TITLE: Record<TemplateDocType, string> = {
  invoice:   'TAX INVOICE',
  quotation: 'QUOTATION',
  contract:  'SERVICE CONTRACT',
  workorder: 'WORK ORDER',
};

const DOC_META: Record<TemplateDocType, string> = {
  invoice:   'Date: {{doc.date}}\nDue: {{invoice.dueDate}}\nStatus: {{doc.status}}',
  quotation: 'Date: {{doc.date}}\nValid Until: {{quotation.validUntil}}\nStatus: {{doc.status}}',
  contract:  'Date: {{doc.date}}\nStart: {{contract.startDate}}\nEnd: {{contract.endDate}}\nStatus: {{doc.status}}',
  workorder: 'Date: {{doc.date}}\nScheduled: {{workorder.scheduledDate}}\nPriority: {{workorder.priority}}\nStatus: {{doc.status}}',
};

const SUBJECT_VAR: Partial<Record<TemplateDocType, string>> = {
  quotation: '{{quotation.title}}',
  contract:  '{{contract.title}}',
  workorder: '{{workorder.title}}',
};

let uidCounter = 0;
function sid(prefix: string): string {
  return `st_${prefix}_${(uidCounter++).toString(36)}`;
}

export function buildStarterElements(docType: TemplateDocType): IDesignElement[] {
  uidCounter = 0;
  const els: IDesignElement[] = [];
  const grey  = '#6b7280';
  const faint = '#9ca3af';

  // ── Header band ────────────────────────────────────────────────────────────
  els.push({ id: sid('logo'), type: 'image', x: 30, y: 30, w: 120, h: 52, src: '{{company.logo}}', objectFit: 'contain' });
  els.push({ id: sid('coname'), type: 'text', x: 30, y: 90, w: 360, h: 26, content: '{{company.name}}', fontSize: 18, fontWeight: 'bold', color: '#111827' });
  els.push({
    id: sid('cometa'), type: 'text', x: 30, y: 118, w: 380, h: 92, fontSize: 9, color: grey, lineHeight: 1.5,
    content: '{{company.address}}\nGSTIN: {{company.gstin}}  PAN: {{company.pan}}\n{{company.email}} · {{company.phone}}\n{{company.website}}',
  });
  els.push({ id: sid('title'), type: 'text', x: 414, y: 30, w: 350, h: 32, content: DOC_TITLE[docType], fontSize: 22, fontWeight: 'bold', textAlign: 'right', color: '#111827' });
  els.push({ id: sid('docid'), type: 'text', x: 414, y: 64, w: 350, h: 18, content: '{{doc.id}}', fontSize: 11, textAlign: 'right', color: grey });
  els.push({ id: sid('docmeta'), type: 'text', x: 414, y: 86, w: 350, h: 76, content: DOC_META[docType], fontSize: 10, textAlign: 'right', color: '#374151', lineHeight: 1.6 });
  els.push({ id: sid('hr'), type: 'divider', x: 30, y: 216, w: 734, h: 3, borderColor: '#e5e7eb', borderWidth: 1 });

  // ── Bill To ────────────────────────────────────────────────────────────────
  els.push({ id: sid('billlbl'), type: 'text', x: 30, y: 230, w: 200, h: 14, content: 'BILL TO', fontSize: 9, fontWeight: 'bold', color: faint });
  els.push({ id: sid('custname'), type: 'text', x: 30, y: 246, w: 340, h: 20, content: '{{customer.name}}', fontSize: 12, fontWeight: 'bold', color: '#111827' });
  els.push({
    id: sid('custmeta'), type: 'text', x: 30, y: 268, w: 340, h: 52, fontSize: 9, color: grey, lineHeight: 1.5,
    content: '{{customer.email}}\n{{customer.phone}}\n{{customer.address}}',
  });

  // Subject / title line for quote/contract/workorder
  const subject = SUBJECT_VAR[docType];
  if (subject) {
    els.push({ id: sid('subjlbl'), type: 'text', x: 414, y: 230, w: 350, h: 14, content: 'SUBJECT', fontSize: 9, fontWeight: 'bold', color: faint, textAlign: 'right' });
    els.push({ id: sid('subject'), type: 'text', x: 414, y: 246, w: 350, h: 40, content: subject, fontSize: 12, fontWeight: 'bold', textAlign: 'right', color: '#111827' });
  }

  // ── Services table (flow) ──────────────────────────────────────────────────
  els.push({ id: sid('svclbl'), type: 'text', x: 30, y: 330, w: 200, h: 14, content: 'SERVICES', fontSize: 9, fontWeight: 'bold', color: faint });
  els.push({
    id: sid('svctable'), type: 'table', x: 30, y: 348, w: 734, h: 150,
    dataset: 'services', showBorders: true, headerBg: '#f3f4f6', headerColor: '#374151', altRowBg: '#f9fafb', fontSize: 10,
  });

  // ── Parts table (flow; renders "No parts listed" when empty) ───────────────
  if (docType === 'invoice' || docType === 'workorder') {
    els.push({ id: sid('prtlbl'), type: 'text', x: 30, y: 510, w: 200, h: 14, content: 'PARTS / MATERIALS', fontSize: 9, fontWeight: 'bold', color: faint });
    els.push({
      id: sid('prttable'), type: 'table', x: 30, y: 528, w: 734, h: 90,
      dataset: 'parts', showBorders: true, headerBg: '#f3f4f6', headerColor: '#374151', altRowBg: '#f9fafb', fontSize: 10,
    });
  }

  // ── Totals (in the band after the last table) ──────────────────────────────
  els.push({
    id: sid('totals'), type: 'totals', x: 494, y: 640, w: 270, h: 110, fontSize: 11,
    totalsRows: [{ key: 'subtotal' }, { key: 'discount' }, { key: 'gst' }, { key: 'total' }],
    totalsEmphasizeLast: true,
  });

  // ── Notes + Terms (flow rich text) ─────────────────────────────────────────
  els.push({ id: sid('notes'), type: 'richtext', x: 30, y: 770, w: 620, h: 70, content: '{{doc.notes}}', fontSize: 10, color: '#4b5563' });
  els.push({ id: sid('terms'), type: 'richtext', x: 30, y: 850, w: 620, h: 70, content: '{{doc.terms}}', fontSize: 9, color: grey });

  // ── Footer band (below all flow blocks) ────────────────────────────────────
  els.push({ id: sid('banklbl'), type: 'text', x: 30, y: 940, w: 200, h: 14, content: 'PAYMENT DETAILS', fontSize: 9, fontWeight: 'bold', color: faint });
  els.push({
    id: sid('bank'), type: 'text', x: 30, y: 956, w: 560, h: 48, fontSize: 9, color: grey, lineHeight: 1.6,
    content: 'Bank: {{bank.name}} · Account Name: {{bank.accountName}}\nAccount No: {{bank.account}} · BSB / IFSC: {{bank.ifsc}} · UPI: {{bank.upi}}',
  });
  els.push({ id: sid('qr'), type: 'image', x: 700, y: 936, w: 64, h: 64, src: '{{bank.qr}}', objectFit: 'contain' });
  els.push({ id: sid('footer'), type: 'text', x: 30, y: 1012, w: 734, h: 18, content: '{{doc.footer}}', fontSize: 9, textAlign: 'center', color: faint });

  els.push({ id: sid('sigimg'),  type: 'image', x: 30,  y: 1040, w: 100, h: 40, src: '{{company.signature}}', objectFit: 'contain' });
  els.push({ id: sid('stamp'),   type: 'image', x: 140, y: 1030, w: 54,  h: 54, src: '{{company.stamp}}', objectFit: 'contain' });
  els.push({ id: sid('sighr1'),  type: 'divider', x: 30, y: 1086, w: 170, h: 3, borderColor: '#9ca3af', borderWidth: 1 });
  els.push({ id: sid('sigtxt1'), type: 'text', x: 30, y: 1090, w: 170, h: 16, content: docType === 'workorder' ? 'Technician Signature' : 'Authorised Signature', fontSize: 9, textAlign: 'center', color: grey });
  els.push({ id: sid('sighr2'),  type: 'divider', x: 594, y: 1086, w: 170, h: 3, borderColor: '#9ca3af', borderWidth: 1 });
  els.push({ id: sid('sigtxt2'), type: 'text', x: 594, y: 1090, w: 170, h: 16, content: 'Customer Signature & Date', fontSize: 9, textAlign: 'center', color: grey });

  return els;
}

export const STARTER_PAGE: ITemplatePage = { marginTopPx: 24, marginBottomPx: 32 };

export const STARTER_NAME = 'Classic (Starter)';
