// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, cur = '$'): string {
  return `${cur}${n != null ? Number(n).toFixed(2) : '0.00'}`;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function currencySymbol(currency?: string): string {
  const map: Record<string, string> = {
    AUD: '$', USD: '$', CAD: '$', NZD: '$', SGD: '$',
    GBP: '£', EUR: '€', INR: '₹',
  };
  return map[currency ?? 'AUD'] ?? '$';
}

function companyFullAddress(s: any): string {
  return [s?.address1, s?.address2, s?.city, s?.state, s?.postalCode, s?.country]
    .filter(Boolean).join(', ');
}

function customerFullAddress(c: any): string {
  return [c?.address, c?.city, c?.state, c?.postcode, c?.country]
    .filter(Boolean).join(', ');
}

function esc(v: any): string {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Context type ────────────────────────────────────────────────────────────

interface Ctx {
  doc: any;
  s:   any;    // FSSettings
  c:   any;    // Customer (may be null)
  cur: string; // currency symbol
}

// ─── Shared service table ────────────────────────────────────────────────────

function svcRows(services: any[], showUnit: boolean, cur: string): string {
  if (!services?.length) {
    return `<tr><td colspan="${showUnit ? 5 : 4}" style="text-align:center;color:#9ca3af;padding:16px 8px">No services listed</td></tr>`;
  }
  return services.map((s: any, i: number) => `
    <tr class="${i % 2 === 1 ? 'tr-alt' : ''}">
      <td>${i + 1}</td>
      <td>
        <strong>${esc(s.name)}</strong>
        ${s.description ? `<br><span style="color:#9ca3af;font-size:10px">${esc(s.description)}</span>` : ''}
      </td>
      <td class="td-r">${s.count ?? 1}</td>
      ${showUnit ? `<td class="td-r">${fmt(s.amount, cur)}</td>` : ''}
      <td class="td-r"><strong>${fmt((s.amount ?? 0) * (s.count ?? 1), cur)}</strong></td>
    </tr>`).join('');
}

// ─── Shared parts table (Parts / Materials) — mirrors every *PrintPage.tsx's
// separate parts table, which the backend previously dropped entirely even
// though the total already includes parts cost. ────────────────────────────

function partRows(parts: any[], cur: string): string {
  return parts.map((p: any, i: number) => `
    <tr class="${i % 2 === 1 ? 'tr-alt' : ''}">
      <td>${i + 1}</td>
      <td>
        <strong>${esc(p.name)}</strong>
        ${p.description ? `<br><span style="color:#9ca3af;font-size:10px">${esc(p.description)}</span>` : ''}
      </td>
      <td>${esc(p.partNumber ?? '—')}</td>
      <td class="td-r">${p.count ?? 1}</td>
      <td class="td-r">${fmt(p.amount, cur)}</td>
      <td class="td-r"><strong>${fmt((p.amount ?? 0) * (p.count ?? 1), cur)}</strong></td>
    </tr>`).join('');
}

function partsTableHtml(parts: any[] | undefined, cur: string): string {
  if (!parts?.length) return '';
  return `
    <p class="section-lbl" style="margin-top:16px">Parts / Materials</p>
    <table>
      <thead><tr>
        <th style="width:32px">#</th><th>Part Name</th><th style="width:100px">Part No.</th>
        <th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th>
      </tr></thead>
      <tbody>${partRows(parts, cur)}</tbody>
    </table>`;
}

// ─── Totals block ─────────────────────────────────────────────────────────────

function totalsHtml(doc: any, label: string, cur: string): string {
  const sub  = doc.servicesAmount ?? 0;
  const disc = doc.discount       ?? 0;
  const gst  = doc.gstPercentage  ?? 0;
  const tot  = doc.servicesAmountWithTax ?? sub;
  const raw  = sub + disc; // subtotal before discount
  return `
    <div class="totals-box">
      <div class="t-row"><span class="t-lbl">Subtotal</span><span>${fmt(raw, cur)}</span></div>
      ${disc > 0 ? `<div class="t-row"><span class="t-lbl" style="color:#dc2626">Discount</span><span style="color:#dc2626">-${fmt(disc, cur)}</span></div>` : ''}
      ${gst > 0  ? `<div class="t-row"><span class="t-lbl">GST (${gst}%)</span><span>${fmt(tot - sub, cur)}</span></div>` : ''}
      <div class="t-row grand"><span>${label}</span><span>${fmt(tot, cur)}</span></div>
    </div>`;
}

// ─── Signature row ───────────────────────────────────────────────────────────

function sigsHtml(left: string, right: string, s: any): string {
  const sigImg = s?.companySignature
    ? `<img src="${esc(s.companySignature)}" style="height:40px;margin-bottom:4px" />`
    : '';
  const stampImg = s?.stampImage
    ? `<img src="${esc(s.stampImage)}" style="height:56px;margin-bottom:4px;margin-left:8px" />`
    : '';
  return `
    <div class="sig-row">
      <div>
        <div style="display:flex;align-items:flex-end;justify-content:center">${sigImg}${stampImg}</div>
        <div class="sig-line">${left}</div>
      </div>
      <div><div class="sig-line">${right}</div></div>
    </div>`;
}

// ─── Bank details block ──────────────────────────────────────────────────────

function bankHtml(s: any, cur: string): string {
  if (!s?.bankName && !s?.accountNumber && !s?.upiId) return '';
  return `
    <div class="bank-box">
      <p class="bank-title">Payment Details</p>
      <div style="display:flex;align-items:flex-start;gap:16px">
        <div class="bank-grid" style="flex:1">
          ${s.bankName      ? `<div><span class="t-lbl">Bank</span><br><strong>${esc(s.bankName)}</strong></div>`          : ''}
          ${s.accountName   ? `<div><span class="t-lbl">Account Name</span><br><strong>${esc(s.accountName)}</strong></div>` : ''}
          ${s.accountNumber ? `<div><span class="t-lbl">Account No.</span><br><strong>${esc(s.accountNumber)}</strong></div>`: ''}
          ${s.ifscCode      ? `<div><span class="t-lbl">BSB / IFSC</span><br><strong>${esc(s.ifscCode)}</strong></div>`     : ''}
          ${s.upiId         ? `<div style="grid-column:span 2"><span class="t-lbl">UPI</span><br><strong>${esc(s.upiId)}</strong></div>` : ''}
        </div>
        ${s.qrCodeImage ? `
        <div style="flex-shrink:0;text-align:center">
          <img src="${esc(s.qrCodeImage)}" style="height:64px;width:64px;object-fit:contain" />
          <div style="font-size:9px;color:#9ca3af;margin-top:2px">Scan to Pay</div>
        </div>` : ''}
      </div>
    </div>`;
}

// ─── Rich-text box (Notes / Terms & Conditions) ──────────────────────────────
// doc.notes and doc.termsAndConditions are authored via the app's RichEditor
// and rendered as raw HTML in every *PrintPage.tsx (dangerouslySetInnerHTML) —
// they must NOT be passed through esc() here or the formatting (and the tags
// themselves) would show up as literal escaped text instead of rendering.
function richBox(label: string, htmlContent?: string): string {
  if (!htmlContent) return '';
  return `<div style="margin-bottom:16px"><p class="section-lbl">${label}</p><div class="notes-box">${htmlContent}</div></div>`;
}

// ─── Status badges ────────────────────────────────────────────────────────────

const INVOICE_BADGE:   Record<string, string> = { paid: 'bg', overdue: 'bd', sent: 'bb', cancelled: 'bz', draft: 'ba' };
const QUOTATION_BADGE: Record<string, string> = { approved: 'bg', sent: 'bb', rejected: 'bd', draft: 'bz' };
const CONTRACT_BADGE:  Record<string, string> = { active: 'bg', expired: 'bd', cancelled: 'bz', draft: 'bb' };
const WORKORDER_BADGE: Record<string, string> = { completed: 'bg', in_progress: 'bb', scheduled: 'bv', cancelled: 'bd', draft: 'bz' };
const PRIORITY_BADGE:  Record<string, string> = { high: 'bd', medium: 'ba', low: 'bg' };

function badge(map: Record<string, string>, val: string): string {
  return `<span class="badge ${map[val] ?? 'bz'}">${val.replace(/_/g, ' ').toUpperCase()}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CLASSIC TEMPLATE ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const CLASSIC_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1f2937; background: white; }
.page { width: 210mm; min-height: 297mm; padding: 15mm; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 14px 0; }
.row { display: flex; justify-content: space-between; align-items: flex-start; }
.text-right { text-align: right; }
.section-lbl { font-size: 10px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 700; margin-left: 4px; }
.bg { background:#dcfce7;color:#166534 } .bb{background:#dbeafe;color:#1e40af}
.ba{background:#fef3c7;color:#92400e} .bd{background:#fee2e2;color:#991b1b}
.bz{background:#f3f4f6;color:#4b5563} .bv{background:#ede9fe;color:#5b21b6}
table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 20px; }
th { background: #f9fafb; border: 1px solid #e5e7eb; padding: 7px 10px; text-align: left; font-weight: 700; color: #374151; }
td { border: 1px solid #e5e7eb; padding: 6px 10px; color: #374151; }
.tr-alt { background: #f9fafb; }
.td-r { text-align: right; }
.totals-box { margin-left: auto; width: 220px; margin-top: 4px; }
.t-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; }
.t-lbl { color: #6b7280; }
.t-row.grand { font-size: 14px; font-weight: 700; color: #111827; border-top: 2px solid #d1d5db; padding-top: 6px; margin-top: 4px; }
.sig-row { display: flex; justify-content: space-between; margin-top: 48px; }
.sig-line { border-top: 1px solid #9ca3af; width: 160px; padding-top: 4px; text-align: center; font-size: 10px; color: #6b7280; }
.notes-box { border: 1px solid #e5e7eb; border-radius: 4px; padding: 10px; font-size: 11px; color: #4b5563; }
.notes-box p { margin: 0 0 4px; } .notes-box p:last-child { margin-bottom: 0; }
.notes-box ul, .notes-box ol { margin: 4px 0; padding-left: 18px; } .notes-box li { margin: 2px 0; }
.notes-box h2, .notes-box h3 { font-size: 12px; margin: 4px 0; }
.hl-box { background: #f9fafb; border-radius: 4px; padding: 10px; margin-bottom: 20px; }
.co-name { font-size: 18px; font-weight: 700; color: #111827; }
.co-meta { font-size: 10px; color: #6b7280; margin-top: 2px; line-height: 1.5; }
.doc-title { font-size: 24px; font-weight: 700; color: #111827; letter-spacing: -0.5px; }
.doc-id { font-size: 11px; color: #6b7280; margin-top: 2px; }
.doc-meta { font-size: 11px; color: #374151; line-height: 1.8; text-align: right; }
.bank-box { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 20px; background: #f9fafb; }
.bank-title { font-size: 12px; font-weight: 700; color: #4b5563; margin-bottom: 8px; }
.bank-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 11px; }
.cust-name { font-size: 13px; font-weight: 700; }
.cust-meta { font-size: 11px; color: #6b7280; margin-top: 2px; line-height: 1.5; }
.footer-text { font-size: 10px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 10px; margin-top: 20px; white-space: pre-line; text-align: center; }
`;

// Full company info block — same fields/order as every *PrintPage.tsx's
// Company Header: address, GSTIN, PAN, Reg #, email, phone, WhatsApp, website, Branch.
function companyMetaLines(s: any): string {
  const addr = companyFullAddress(s);
  return `
    ${addr ? `${esc(addr)}<br>` : ''}
    ${s?.gstin             ? `GSTIN: ${esc(s.gstin)}<br>` : ''}
    ${s?.pan               ? `PAN: ${esc(s.pan)}<br>` : ''}
    ${s?.businessRegNumber ? `Reg: ${esc(s.businessRegNumber)}<br>` : ''}
    ${s?.companyEmail      ? `${esc(s.companyEmail)}<br>` : ''}
    ${s?.phone             ? `${esc(s.phone)}<br>` : ''}
    ${s?.whatsapp          ? `WA: ${esc(s.whatsapp)}<br>` : ''}
    ${s?.website            ? `${esc(s.website)}<br>` : ''}
    ${s?.branch            ? `Branch: ${esc(s.branch)}` : ''}`;
}

function classicHeader(ctx: Ctx, docTitle: string, docId: string, metaRight: string): string {
  const { s } = ctx;
  return `
    <div class="row" style="margin-bottom:20px;align-items:flex-start">
      <div>
        ${s?.companyLogo ? `<img src="${esc(s.companyLogo)}" style="height:52px;margin-bottom:6px;display:block" />` : ''}
        ${s?.companyName ? `<div class="co-name">${esc(s.companyName)}</div>` : ''}
        <div class="co-meta">${companyMetaLines(s)}</div>
      </div>
      <div>
        <div class="doc-title">${docTitle}</div>
        <div class="doc-id">${esc(docId)}</div>
        <div class="doc-meta" style="margin-top:8px">${metaRight}</div>
      </div>
    </div>
    <hr>`;
}

function classicBillTo(ctx: Ctx, extraAddr?: string): string {
  const { c, doc } = ctx;
  const name = c?.name ?? doc.customerId ?? '';
  const addr = customerFullAddress(c) || extraAddr || '';
  return `
    <div style="margin-bottom:20px">
      <p class="section-lbl">Bill To</p>
      <div class="cust-name">${esc(name)}</div>
      <div class="cust-meta">
        ${c?.email ? `${esc(c.email)}<br>` : ''}
        ${c?.phone ? `${esc(c.phone)}<br>` : ''}
        ${addr ? esc(addr) : ''}
        ${extraAddr && addr !== extraAddr ? `<br>${esc(extraAddr)}` : ''}
      </div>
    </div>`;
}

function classicFooter(text?: string): string {
  if (!text) return '';
  return `<div class="footer-text">${esc(text)}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MODERN TEMPLATE ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const MODERN_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1e293b; background: white; }
.page { width: 210mm; min-height: 297mm; padding: 0; }
.mod-header { background: #0f172a; color: white; padding: 16mm 15mm 10mm; display: flex; justify-content: space-between; align-items: flex-start; }
.mod-logo { height: 48px; margin-bottom: 6px; display: block; }
.mod-co { font-size: 17px; font-weight: 700; color: white; }
.mod-co-meta { font-size: 10px; color: #94a3b8; margin-top: 3px; line-height: 1.6; }
.mod-doc { text-align: right; }
.mod-doc-title { font-size: 26px; font-weight: 800; color: white; letter-spacing: -0.5px; }
.mod-doc-id { font-size: 11px; color: #94a3b8; margin-top: 2px; }
.mod-doc-meta { font-size: 11px; color: #cbd5e1; margin-top: 8px; line-height: 1.8; }
.mod-body { padding: 10mm 15mm 15mm; }
.mod-info-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 20px; padding: 14px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #0f172a; }
.section-lbl { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 4px; }
.cust-name { font-size: 13px; font-weight: 700; color: #0f172a; }
.cust-meta { font-size: 11px; color: #64748b; margin-top: 2px; line-height: 1.5; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 9999px; font-size: 10px; font-weight: 700; margin-left: 4px; }
.bg{background:#dcfce7;color:#166534} .bb{background:#dbeafe;color:#1e40af}
.ba{background:#fef3c7;color:#92400e} .bd{background:#fee2e2;color:#991b1b}
.bz{background:#f3f4f6;color:#4b5563} .bv{background:#ede9fe;color:#5b21b6}
table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 20px; border-radius: 8px; overflow: hidden; }
th { background: #0f172a; color: white; padding: 8px 12px; text-align: left; font-weight: 600; }
td { border-bottom: 1px solid #e2e8f0; padding: 8px 12px; color: #334155; }
.tr-alt { background: #f8fafc; }
.td-r { text-align: right; }
.totals-box { margin-left: auto; width: 240px; background: #f8fafc; border-radius: 8px; padding: 14px; border: 1px solid #e2e8f0; }
.t-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; }
.t-lbl { color: #64748b; }
.t-row.grand { font-size: 15px; font-weight: 800; color: #0f172a; border-top: 2px solid #0f172a; padding-top: 8px; margin-top: 6px; }
.sig-row { display: flex; justify-content: space-between; margin-top: 48px; }
.sig-line { border-top: 1px solid #94a3b8; width: 160px; padding-top: 4px; text-align: center; font-size: 10px; color: #64748b; }
.notes-box { border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-size: 11px; color: #475569; background: #f8fafc; }
.notes-box p { margin: 0 0 4px; } .notes-box p:last-child { margin-bottom: 0; }
.notes-box ul, .notes-box ol { margin: 4px 0; padding-left: 18px; } .notes-box li { margin: 2px 0; }
.notes-box h2, .notes-box h3 { font-size: 12px; margin: 4px 0; }
.hl-box { background: #f8fafc; border-radius: 6px; padding: 12px; margin-bottom: 20px; border-left: 4px solid #0f172a; }
.bank-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 20px; background: #f8fafc; }
.bank-title { font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 8px; }
.bank-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 11px; }
.footer-text { font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 20px; white-space: pre-line; text-align: center; }
`;

function modernHeader(ctx: Ctx, docTitle: string, docId: string, metaRight: string): string {
  const { s } = ctx;
  return `
    <div class="mod-header">
      <div>
        ${s?.companyLogo ? `<img src="${esc(s.companyLogo)}" class="mod-logo" />` : ''}
        ${s?.companyName ? `<div class="mod-co">${esc(s.companyName)}</div>` : ''}
        <div class="mod-co-meta">${companyMetaLines(s)}</div>
      </div>
      <div class="mod-doc">
        <div class="mod-doc-title">${docTitle}</div>
        <div class="mod-doc-id">${esc(docId)}</div>
        <div class="mod-doc-meta">${metaRight}</div>
      </div>
    </div>
    <div class="mod-body">`;
}

function modernBillTo(ctx: Ctx, companyInfo: string, extraAddr?: string): string {
  const { c, doc } = ctx;
  const name = c?.name ?? doc.customerId ?? '';
  const addr = customerFullAddress(c) || extraAddr || '';
  return `
    <div class="mod-info-row">
      <div>
        <p class="section-lbl">From</p>
        <div style="font-size:11px;color:#334155;line-height:1.6">${companyInfo}</div>
      </div>
      <div>
        <p class="section-lbl">Bill To</p>
        <div class="cust-name">${esc(name)}</div>
        <div class="cust-meta">
          ${c?.email ? `${esc(c.email)}<br>` : ''}
          ${c?.phone ? `${esc(c.phone)}<br>` : ''}
          ${addr ? esc(addr) : ''}
          ${extraAddr && addr !== extraAddr ? `<br>${esc(extraAddr)}` : ''}
        </div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MINIMAL TEMPLATE ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const MINIMAL_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 12px; color: #111; background: white; }
.page { width: 210mm; min-height: 297mm; padding: 18mm 18mm 15mm; }
.row { display: flex; justify-content: space-between; align-items: flex-start; }
.section-lbl { font-size: 9px; font-weight: bold; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
.badge { display: inline-block; padding: 2px 7px; font-size: 9px; font-weight: bold; border: 1px solid currentColor; border-radius: 2px; margin-left: 4px; }
.bg{color:#166534;border-color:#166534} .bb{color:#1e40af;border-color:#1e40af}
.ba{color:#92400e;border-color:#92400e} .bd{color:#991b1b;border-color:#991b1b}
.bz{color:#4b5563;border-color:#4b5563} .bv{color:#5b21b6;border-color:#5b21b6}
table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 20px; }
th { border-bottom: 2px solid #111; padding: 6px 8px; text-align: left; font-family: Arial, sans-serif; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: bold; }
td { border-bottom: 1px solid #e5e7eb; padding: 7px 8px; }
.tr-alt { }
.td-r { text-align: right; }
.totals-box { margin-left: auto; width: 210px; }
.t-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; border-bottom: 1px solid #e5e7eb; }
.t-lbl { color: #555; }
.t-row.grand { font-size: 14px; font-weight: bold; border-bottom: none; border-top: 2px solid #111; padding-top: 8px; margin-top: 4px; }
.sig-row { display: flex; justify-content: space-between; margin-top: 56px; }
.sig-line { border-top: 1px solid #555; width: 160px; padding-top: 4px; text-align: center; font-size: 10px; color: #777; font-family: Arial, sans-serif; }
.notes-box { border-left: 3px solid #e5e7eb; padding-left: 12px; font-size: 11px; color: #555; }
.notes-box p { margin: 0 0 4px; } .notes-box p:last-child { margin-bottom: 0; }
.notes-box ul, .notes-box ol { margin: 4px 0; padding-left: 18px; } .notes-box li { margin: 2px 0; }
.notes-box h2, .notes-box h3 { font-size: 12px; margin: 4px 0; }
.hl-box { border-left: 3px solid #111; padding-left: 12px; margin-bottom: 20px; }
.bank-box { border: 1px solid #e5e7eb; padding: 12px; margin-bottom: 20px; font-family: Arial, sans-serif; }
.bank-title { font-size: 12px; font-weight: 700; color: #333; margin-bottom: 8px; }
.bank-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 11px; }
.co-name { font-size: 20px; font-weight: bold; letter-spacing: -0.5px; }
.co-meta { font-size: 10px; color: #555; margin-top: 3px; line-height: 1.6; font-family: Arial, sans-serif; }
.doc-title { font-size: 20px; font-weight: bold; text-align: right; text-transform: uppercase; letter-spacing: 1px; }
.doc-id { font-size: 10px; color: #777; text-align: right; margin-top: 2px; font-family: Arial, sans-serif; }
.doc-meta { font-size: 11px; color: #333; text-align: right; line-height: 1.8; font-family: Arial, sans-serif; margin-top: 6px; }
.cust-name { font-size: 13px; font-weight: bold; }
.cust-meta { font-size: 11px; color: #555; margin-top: 2px; line-height: 1.5; font-family: Arial, sans-serif; }
.footer-text { font-size: 10px; color: #999; border-top: 1px solid #e5e7eb; padding-top: 10px; margin-top: 20px; white-space: pre-line; text-align: center; font-family: Arial, sans-serif; }
`;

function minimalHeader(ctx: Ctx, docTitle: string, docId: string, metaRight: string): string {
  const { s } = ctx;
  return `
    <div class="row" style="margin-bottom:24px;align-items:flex-start">
      <div>
        ${s?.companyLogo ? `<img src="${esc(s.companyLogo)}" style="height:44px;margin-bottom:6px;display:block" />` : ''}
        ${s?.companyName ? `<div class="co-name">${esc(s.companyName)}</div>` : ''}
        <div class="co-meta">${companyMetaLines(s)}</div>
      </div>
      <div>
        <div class="doc-title">${docTitle}</div>
        <div class="doc-id">${esc(docId)}</div>
        <div class="doc-meta">${metaRight}</div>
      </div>
    </div>
    <hr style="border:none;border-top:2px solid #111;margin-bottom:20px">`;
}

function minimalBillTo(ctx: Ctx, extraAddr?: string): string {
  const { c, doc } = ctx;
  const name = c?.name ?? doc.customerId ?? '';
  const addr = customerFullAddress(c) || extraAddr || '';
  return `
    <div style="margin-bottom:24px">
      <p class="section-lbl">Bill To</p>
      <div class="cust-name">${esc(name)}</div>
      <div class="cust-meta">
        ${c?.email ? `${esc(c.email)}<br>` : ''}
        ${c?.phone ? `${esc(c.phone)}<br>` : ''}
        ${addr ? esc(addr) : ''}
        ${extraAddr && addr !== extraAddr ? `<br>${esc(extraAddr)}` : ''}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Wrap into full HTML document ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function html(css: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── INVOICE TEMPLATES ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function invoiceClassic(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    <div>Date: ${fmtDate(doc.createdAt)}</div>
    ${doc.dueDate    ? `<div>Due: ${fmtDate(doc.dueDate)}</div>`      : ''}
    ${doc.workOrderId? `<div>Work Order: ${esc(doc.workOrderId)}</div>` : ''}
    <div style="margin-top:6px">${badge(INVOICE_BADGE, doc.status ?? 'draft')}${doc.paid ? `<span class="badge bg">PAID</span>` : ''}</div>`;
  return html(CLASSIC_CSS, `<div class="page">
    ${classicHeader(ctx, 'TAX INVOICE', doc.invoiceId ?? '', metaRight)}
    ${classicBillTo(ctx, doc.address)}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'TOTAL DUE', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.invoiceFooter ? `<div class="footer-text">${esc(s.invoiceFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Customer Acknowledgement', s)}
  </div>`);
}

function invoiceModern(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const addr = companyFullAddress(s);
  const companyInfo = [s?.companyName, addr, s?.gstin ? `GSTIN: ${s.gstin}` : '', s?.companyEmail, s?.phone].filter(Boolean).join('<br>');
  const metaRight = `
    <div>Date: ${fmtDate(doc.createdAt)}</div>
    ${doc.dueDate ? `<div>Due: ${fmtDate(doc.dueDate)}</div>` : ''}
    ${doc.workOrderId ? `<div>Work Order: ${esc(doc.workOrderId)}</div>` : ''}
    <div style="margin-top:6px">${badge(INVOICE_BADGE, doc.status ?? 'draft')}${doc.paid ? `<span class="badge bg" style="margin-left:4px">PAID</span>` : ''}</div>`;
  return html(MODERN_CSS, `
    ${modernHeader(ctx, 'TAX INVOICE', doc.invoiceId ?? '', metaRight)}
    ${modernBillTo(ctx, companyInfo, doc.address)}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'TOTAL DUE', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.invoiceFooter ? `<div class="footer-text">${esc(s.invoiceFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Customer Acknowledgement', s)}
    </div>`);
}

function invoiceMinimal(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    ${fmtDate(doc.createdAt)}<br>
    ${doc.dueDate ? `Due: ${fmtDate(doc.dueDate)}<br>` : ''}
    ${badge(INVOICE_BADGE, doc.status ?? 'draft')}${doc.paid ? `<span class="badge bg">PAID</span>` : ''}`;
  return html(MINIMAL_CSS, `<div class="page">
    ${minimalHeader(ctx, 'Tax Invoice', doc.invoiceId ?? '', metaRight)}
    ${minimalBillTo(ctx, doc.address)}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'Total Due', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.invoiceFooter ? `<div class="footer-text">${esc(s.invoiceFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Customer Acknowledgement', s)}
  </div>`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── QUOTATION TEMPLATES ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function quotationClassic(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    <div>Date: ${fmtDate(doc.createdAt)}</div>
    ${doc.validUntil ? `<div>Valid Until: ${fmtDate(doc.validUntil)}</div>` : ''}
    <div style="margin-top:6px">${badge(QUOTATION_BADGE, doc.status ?? 'draft')}</div>`;
  return html(CLASSIC_CSS, `<div class="page">
    ${classicHeader(ctx, 'QUOTATION', doc.quotationId ?? '', metaRight)}
    ${classicBillTo(ctx, doc.address)}
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Subject</p><p style="font-weight:700;font-size:13px">${esc(doc.title)}</p></div>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'TOTAL', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.quotationFooter ? `<div class="footer-text">${esc(s.quotationFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Client Acceptance &amp; Date', s)}
  </div>`);
}

function quotationModern(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const addr = companyFullAddress(s);
  const companyInfo = [s?.companyName, addr, s?.gstin ? `GSTIN: ${s.gstin}` : '', s?.companyEmail, s?.phone].filter(Boolean).join('<br>');
  const metaRight = `
    <div>Date: ${fmtDate(doc.createdAt)}</div>
    ${doc.validUntil ? `<div>Valid Until: ${fmtDate(doc.validUntil)}</div>` : ''}
    <div style="margin-top:6px">${badge(QUOTATION_BADGE, doc.status ?? 'draft')}</div>`;
  return html(MODERN_CSS, `
    ${modernHeader(ctx, 'QUOTATION', doc.quotationId ?? '', metaRight)}
    ${modernBillTo(ctx, companyInfo, doc.address)}
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Subject</p><p style="font-weight:700;font-size:13px;color:#0f172a">${esc(doc.title)}</p></div>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'TOTAL', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.quotationFooter ? `<div class="footer-text">${esc(s.quotationFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Client Acceptance &amp; Date', s)}
    </div>`);
}

function quotationMinimal(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    ${fmtDate(doc.createdAt)}<br>
    ${doc.validUntil ? `Valid Until: ${fmtDate(doc.validUntil)}<br>` : ''}
    ${badge(QUOTATION_BADGE, doc.status ?? 'draft')}`;
  return html(MINIMAL_CSS, `<div class="page">
    ${minimalHeader(ctx, 'Quotation', doc.quotationId ?? '', metaRight)}
    ${minimalBillTo(ctx, doc.address)}
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Subject</p><p style="font-weight:bold;font-size:13px">${esc(doc.title)}</p></div>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Description</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'Total', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.quotationFooter ? `<div class="footer-text">${esc(s.quotationFooter)}</div>` : ''}
    ${sigsHtml('Authorised Signature', 'Client Acceptance &amp; Date', s)}
  </div>`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CONTRACT TEMPLATES ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function contractClassic(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    <div>Created: ${fmtDate(doc.createdAt)}</div>
    ${doc.startDate ? `<div>Start: ${fmtDate(doc.startDate)}</div>` : ''}
    ${doc.endDate   ? `<div>End: ${fmtDate(doc.endDate)}</div>`     : ''}
    <div style="margin-top:6px">${badge(CONTRACT_BADGE, doc.status ?? 'draft')}</div>`;
  return html(CLASSIC_CSS, `<div class="page">
    ${classicHeader(ctx, 'SERVICE CONTRACT', doc.contractId ?? '', metaRight)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <div>${classicBillTo(ctx)}</div>
      <div>
        ${doc.serviceFrequency ? `<p class="section-lbl">Service Frequency</p><p style="font-weight:700;text-transform:capitalize;margin-bottom:12px">${esc(doc.serviceFrequency)}</p>` : ''}
        ${doc.quotationId ? `<p class="section-lbl">Based on Quotation</p><p style="font-weight:700">${esc(doc.quotationId)}</p>` : ''}
      </div>
    </div>
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Contract Title</p><p style="font-weight:700;font-size:13px">${esc(doc.title)}</p></div>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'CONTRACT VALUE', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.contractFooter ? `<div class="footer-text">${esc(s.contractFooter)}</div>` : ''}
    ${sigsHtml('Service Provider Signature', 'Client Signature &amp; Date', s)}
  </div>`);
}

function contractModern(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const addr = companyFullAddress(s);
  const companyInfo = [s?.companyName, addr, s?.gstin ? `GSTIN: ${s.gstin}` : '', s?.companyEmail, s?.phone].filter(Boolean).join('<br>');
  const metaRight = `
    <div>Created: ${fmtDate(doc.createdAt)}</div>
    ${doc.startDate ? `<div>Start: ${fmtDate(doc.startDate)}</div>` : ''}
    ${doc.endDate   ? `<div>End: ${fmtDate(doc.endDate)}</div>`     : ''}
    <div style="margin-top:6px">${badge(CONTRACT_BADGE, doc.status ?? 'draft')}</div>`;
  return html(MODERN_CSS, `
    ${modernHeader(ctx, 'SERVICE CONTRACT', doc.contractId ?? '', metaRight)}
    ${modernBillTo(ctx, companyInfo)}
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Contract Title</p><p style="font-weight:700;font-size:13px;color:#0f172a">${esc(doc.title)}</p></div>` : ''}
    ${doc.serviceFrequency ? `<p style="margin-bottom:16px;font-size:11px"><span style="font-weight:700">Service Frequency:</span> <span style="text-transform:capitalize">${esc(doc.serviceFrequency)}</span></p>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'CONTRACT VALUE', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.contractFooter ? `<div class="footer-text">${esc(s.contractFooter)}</div>` : ''}
    ${sigsHtml('Service Provider Signature', 'Client Signature &amp; Date', s)}
    </div>`);
}

function contractMinimal(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    ${fmtDate(doc.createdAt)}<br>
    ${doc.startDate ? `Start: ${fmtDate(doc.startDate)}<br>` : ''}
    ${doc.endDate   ? `End: ${fmtDate(doc.endDate)}<br>`     : ''}
    ${badge(CONTRACT_BADGE, doc.status ?? 'draft')}`;
  return html(MINIMAL_CSS, `<div class="page">
    ${minimalHeader(ctx, 'Service Contract', doc.contractId ?? '', metaRight)}
    ${minimalBillTo(ctx)}
    ${doc.title ? `<div class="hl-box"><p class="section-lbl">Contract Title</p><p style="font-weight:bold;font-size:13px">${esc(doc.title)}</p></div>` : ''}
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Unit Price</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services ?? [], true, cur)}</tbody>
    </table>
    ${partsTableHtml(doc.parts, cur)}
    ${totalsHtml(doc, 'Contract Value', cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${bankHtml(s, cur)}
    ${s?.contractFooter ? `<div class="footer-text">${esc(s.contractFooter)}</div>` : ''}
    ${sigsHtml('Service Provider Signature', 'Client Signature &amp; Date', s)}
  </div>`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WORKORDER TEMPLATES ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function workorderClassic(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const metaRight = `
    <div>Created: ${fmtDate(doc.createdAt)}</div>
    ${doc.scheduledDate ? `<div>Scheduled: ${fmtDate(doc.scheduledDate)}</div>`  : ''}
    ${doc.completedDate ? `<div>Completed: ${fmtDate(doc.completedDate)}</div>` : ''}
    <div style="margin-top:6px">
      ${badge(PRIORITY_BADGE, doc.priority ?? 'medium')}
      ${badge(WORKORDER_BADGE, doc.status ?? 'draft')}
    </div>`;
  const { c } = ctx;
  const custName = c?.name ?? doc.customerId ?? '—';
  return html(CLASSIC_CSS, `<div class="page">
    ${classicHeader(ctx, 'WORK ORDER', doc.workOrderId ?? '', metaRight)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <div><p class="section-lbl">Customer</p><p style="font-weight:700">${esc(custName)}</p>
        ${c?.phone ? `<p style="color:#6b7280;font-size:11px">${esc(c.phone)}</p>` : ''}
      </div>
      ${doc.siteId  ? `<div><p class="section-lbl">Site</p><p style="font-weight:700">${esc(doc.siteId)}</p></div>`  : ''}
      ${doc.teamId  ? `<div><p class="section-lbl">Team</p><p style="font-weight:700">${esc(doc.teamId)}</p></div>`  : ''}
      ${doc.staffId ? `<div><p class="section-lbl">Assigned To</p><p style="font-weight:700">${esc(doc.staffId)}</p></div>` : ''}
    </div>
    <div class="hl-box">
      <p class="section-lbl">Work Description</p>
      <p style="font-weight:700;font-size:13px">${esc(doc.title ?? '')}</p>
    </div>
    ${(doc.services ?? []).length > 0 ? `
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services, false, cur)}</tbody>
    </table>` : ''}
    ${partsTableHtml(doc.parts, cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${s?.workorderFooter ? `<div class="footer-text">${esc(s.workorderFooter)}</div>` : ''}
    ${sigsHtml('Technician Signature', 'Customer Signature &amp; Date', s)}
  </div>`);
}

function workorderModern(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const addr = companyFullAddress(s);
  const companyInfo = [s?.companyName, addr, s?.companyEmail, s?.phone].filter(Boolean).join('<br>');
  const { c } = ctx;
  const custName = c?.name ?? doc.customerId ?? '—';
  const metaRight = `
    <div>Created: ${fmtDate(doc.createdAt)}</div>
    ${doc.scheduledDate ? `<div>Scheduled: ${fmtDate(doc.scheduledDate)}</div>` : ''}
    ${doc.completedDate ? `<div>Completed: ${fmtDate(doc.completedDate)}</div>` : ''}
    <div style="margin-top:6px">
      ${badge(PRIORITY_BADGE, doc.priority ?? 'medium')}
      ${badge(WORKORDER_BADGE, doc.status ?? 'draft')}
    </div>`;
  return html(MODERN_CSS, `
    ${modernHeader(ctx, 'WORK ORDER', doc.workOrderId ?? '', metaRight)}
    <div class="mod-info-row">
      <div>
        <p class="section-lbl">From</p>
        <div style="font-size:11px;color:#334155;line-height:1.6">${companyInfo}</div>
      </div>
      <div>
        <p class="section-lbl">Customer</p>
        <div class="cust-name">${esc(custName)}</div>
        <div class="cust-meta">
          ${c?.email ? `${esc(c.email)}<br>` : ''}
          ${c?.phone ? `${esc(c.phone)}<br>` : ''}
          ${customerFullAddress(c) ? esc(customerFullAddress(c)) : ''}
        </div>
      </div>
    </div>
    ${doc.siteId || doc.teamId || doc.staffId ? `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px">
      ${doc.siteId  ? `<div><p class="section-lbl">Site</p><p style="font-weight:700;font-size:11px">${esc(doc.siteId)}</p></div>`       : ''}
      ${doc.teamId  ? `<div><p class="section-lbl">Team</p><p style="font-weight:700;font-size:11px">${esc(doc.teamId)}</p></div>`       : ''}
      ${doc.staffId ? `<div><p class="section-lbl">Assigned To</p><p style="font-weight:700;font-size:11px">${esc(doc.staffId)}</p></div>` : ''}
    </div>` : ''}
    <div class="hl-box"><p class="section-lbl">Work Description</p><p style="font-weight:700;font-size:13px;color:#0f172a">${esc(doc.title ?? '')}</p></div>
    ${(doc.services ?? []).length > 0 ? `
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services, false, cur)}</tbody>
    </table>` : ''}
    ${partsTableHtml(doc.parts, cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${s?.workorderFooter ? `<div class="footer-text">${esc(s.workorderFooter)}</div>` : ''}
    ${sigsHtml('Technician Signature', 'Customer Signature &amp; Date', s)}
    </div>`);
}

function workorderMinimal(ctx: Ctx): string {
  const { doc, s, cur } = ctx;
  const { c } = ctx;
  const custName = c?.name ?? doc.customerId ?? '—';
  const metaRight = `
    ${fmtDate(doc.createdAt)}<br>
    ${doc.scheduledDate ? `Scheduled: ${fmtDate(doc.scheduledDate)}<br>` : ''}
    ${badge(PRIORITY_BADGE, doc.priority ?? 'medium')}
    ${badge(WORKORDER_BADGE, doc.status ?? 'draft')}`;
  return html(MINIMAL_CSS, `<div class="page">
    ${minimalHeader(ctx, 'Work Order', doc.workOrderId ?? '', metaRight)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <div>
        <p class="section-lbl">Customer</p>
        <div class="cust-name">${esc(custName)}</div>
        <div class="cust-meta">${c?.phone ? esc(c.phone) : ''}</div>
      </div>
      ${doc.staffId ? `<div><p class="section-lbl">Assigned To</p><div class="cust-name" style="font-size:12px">${esc(doc.staffId)}</div></div>` : ''}
    </div>
    <div class="hl-box">
      <p class="section-lbl">Work Description</p>
      <p style="font-weight:bold;font-size:13px">${esc(doc.title ?? '')}</p>
    </div>
    ${(doc.services ?? []).length > 0 ? `
    <p class="section-lbl">Services</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Service</th><th class="td-r" style="width:50px">Qty</th><th class="td-r" style="width:80px">Amount</th></tr></thead>
      <tbody>${svcRows(doc.services, false, cur)}</tbody>
    </table>` : ''}
    ${partsTableHtml(doc.parts, cur)}
    ${richBox('Notes', doc.notes)}
    ${richBox('Terms &amp; Conditions', doc.termsAndConditions)}
    ${s?.workorderFooter ? `<div class="footer-text">${esc(s.workorderFooter)}</div>` : ''}
    ${sigsHtml('Technician Signature', 'Customer Signature &amp; Date', s)}
  </div>`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PUBLIC API — one function per document type ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export function invoiceTemplate(doc: any, settings?: any, customer?: any, variant = 'classic'): string {
  const ctx: Ctx = { doc, s: settings ?? {}, c: customer ?? null, cur: currencySymbol(settings?.currency) };
  if (variant === 'modern')  return invoiceModern(ctx);
  if (variant === 'minimal') return invoiceMinimal(ctx);
  return invoiceClassic(ctx);
}

export function quotationTemplate(doc: any, settings?: any, customer?: any, variant = 'classic'): string {
  const ctx: Ctx = { doc, s: settings ?? {}, c: customer ?? null, cur: currencySymbol(settings?.currency) };
  if (variant === 'modern')  return quotationModern(ctx);
  if (variant === 'minimal') return quotationMinimal(ctx);
  return quotationClassic(ctx);
}

export function contractTemplate(doc: any, settings?: any, customer?: any, variant = 'classic'): string {
  const ctx: Ctx = { doc, s: settings ?? {}, c: customer ?? null, cur: currencySymbol(settings?.currency) };
  if (variant === 'modern')  return contractModern(ctx);
  if (variant === 'minimal') return contractMinimal(ctx);
  return contractClassic(ctx);
}

export function workorderTemplate(doc: any, settings?: any, customer?: any, variant = 'classic'): string {
  const ctx: Ctx = { doc, s: settings ?? {}, c: customer ?? null, cur: currencySymbol(settings?.currency) };
  if (variant === 'modern')  return workorderModern(ctx);
  if (variant === 'minimal') return workorderMinimal(ctx);
  return workorderClassic(ctx);
}
