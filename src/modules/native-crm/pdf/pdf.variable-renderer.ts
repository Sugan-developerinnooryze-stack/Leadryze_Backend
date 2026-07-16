import { IDesignElement } from '../custom-templates/custom-template.model';

const CUR_SYMBOL: Record<string, string> = {
  AUD:'$', USD:'$', GBP:'£', EUR:'€', INR:'₹', CAD:'$', NZD:'$', SGD:'$',
};

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d: any): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMoney(n: any, cur: string): string {
  return `${cur}${Number(n ?? 0).toFixed(2)}`;
}

function buildVarMap(doc: any, settings: any, customer: any): Record<string, string> {
  const cur = CUR_SYMBOL[settings?.currency ?? 'AUD'] ?? '$';
  const companyAddr = [settings?.address1, settings?.city, settings?.state, settings?.postalCode, settings?.country]
    .filter(Boolean).join(', ');
  const custAddr = [customer?.address, customer?.city, customer?.state, customer?.postcode, customer?.country]
    .filter(Boolean).join(', ');
  const docId = doc.invoiceId ?? doc.quotationId ?? doc.contractId ?? doc.workOrderId ?? '';
  const subtotal = doc.servicesAmount ?? 0;
  const discount = doc.discount ?? 0;
  const total    = doc.servicesAmountWithTax ?? 0;

  return {
    'company.name':    esc(settings?.companyName    ?? ''),
    'company.logo':    settings?.companyLogo        ?? '',
    'company.address': esc(companyAddr),
    'company.gstin':   esc(settings?.gstin          ?? ''),
    'company.email':   esc(settings?.companyEmail   ?? ''),
    'company.phone':   esc(settings?.phone          ?? ''),
    'customer.name':   esc(customer?.name           ?? ''),
    'customer.email':  esc(customer?.email          ?? ''),
    'customer.phone':  esc(customer?.phone          ?? ''),
    'customer.address':esc(custAddr),
    'doc.id':          esc(docId),
    'doc.date':        esc(fmtDate(doc.createdAt)),
    'doc.dueDate':     esc(fmtDate(doc.dueDate ?? doc.validUntil)),
    'doc.status':      esc((doc.status ?? '').toUpperCase()),
    'doc.total':       esc(fmtMoney(total, cur)),
    'doc.subtotal':    esc(fmtMoney(subtotal + discount, cur)),
    'doc.discount':    esc(fmtMoney(discount, cur)),
    'doc.gst':         esc(`${doc.gstPercentage ?? 0}%`),
    'bank.name':       esc(settings?.bankName       ?? ''),
    'bank.account':    esc(settings?.accountNumber  ?? ''),
    'bank.ifsc':       esc(settings?.ifscCode       ?? ''),
    'bank.upi':        esc(settings?.upiId          ?? ''),
  };
}

function servicesTableHtml(doc: any, cur: string): string {
  const rows = (doc.services ?? []).map((s: any, i: number) => `
    <tr style="background:${i%2===0?'#fff':'#f9fafb'}">
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i+1}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb"><b>${esc(s.name??'')}</b>${s.description?`<br><span style="color:#9ca3af;font-size:11px">${esc(s.description)}</span>`:''}
      </td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">${s.count??1}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">${cur}${Number(s.amount??0).toFixed(2)}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right"><b>${cur}${Number((s.amount??0)*(s.count??1)).toFixed(2)}</b></td>
    </tr>`).join('');
  return `
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">#</th>
          <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">Description</th>
          <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">Qty</th>
          <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">Unit Price</th>
          <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5" style="padding:8px;text-align:center;color:#9ca3af">No services</td></tr>'}</tbody>
    </table>`;
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? '');
}

function renderElement(el: IDesignElement, vars: Record<string, string>, doc: any, settings: any): string {
  const cur = CUR_SYMBOL[settings?.currency ?? 'AUD'] ?? '$';
  const pos = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;overflow:hidden;`;

  if (el.type === 'divider') {
    return `<div style="${pos}border-top:${el.borderWidth??1}px solid ${el.borderColor??'#e5e7eb'};"></div>`;
  }

  if (el.type === 'box') {
    return `<div style="${pos}background:${el.backgroundColor??'transparent'};border:${el.borderWidth??0}px solid ${el.borderColor??'transparent'};border-radius:4px;"></div>`;
  }

  if (el.type === 'image') {
    const src = el.src ? replaceVars(el.src, vars) : '';
    if (!src) return `<div style="${pos}"></div>`;
    return `<div style="${pos}"><img src="${src}" style="max-width:100%;max-height:100%;object-fit:contain;" /></div>`;
  }

  if (el.type === 'table') {
    return `<div style="${pos}font-size:11px">${servicesTableHtml(doc, cur)}</div>`;
  }

  // text
  const text    = el.content ? replaceVars(el.content, vars) : '';
  const style   = [
    pos,
    `font-size:${el.fontSize??14}px`,
    `font-weight:${el.fontWeight??'normal'}`,
    `font-style:${el.fontStyle??'normal'}`,
    `color:${el.color??'#111827'}`,
    `text-align:${el.textAlign??'left'}`,
    'white-space:pre-wrap',
    'word-break:break-word',
  ].join(';');
  return `<div style="${style}">${text}</div>`;
}

export function renderCustomTemplate(
  elements: IDesignElement[],
  doc:      any,
  settings: any,
  customer: any,
): string {
  const vars  = buildVarMap(doc, settings, customer);
  const body  = elements.map(el => renderElement(el, vars, doc, settings)).join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #111827; background: #fff; }
  .page { position: relative; width: 794px; min-height: 1123px; background: #fff; margin: 0 auto; }
</style>
</head>
<body>
<div class="page">${body}</div>
</body>
</html>`;
}
