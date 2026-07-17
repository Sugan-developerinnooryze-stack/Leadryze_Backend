import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendError, sendSuccess } from '../../../utils/response';
import { getQuotationById } from '../quotations/quotation.service';
import { getWorkorderById } from '../workorders/workorder.service';
import { getContractById }  from '../contracts/contract.service';
import { getInvoiceById }   from '../invoices/invoice.service';
import { generatePdfFromHtml } from './pdf.service';
import {
  quotationTemplate,
  workorderTemplate,
  contractTemplate,
  invoiceTemplate,
} from './pdf.templates';
import { FSSettings }            from '../fs-settings/fs-settings.model';
import { NativeCustomer }        from '../customers/customer.model';
import { DocTemplatePreference } from '../fs-settings/doc-template-preference.model';
import { CustomTemplate }        from '../custom-templates/custom-template.model';
import { renderCustomTemplate }  from './pdf.variable-renderer';
import { sendEmailNow }          from '../../messages/brevo.service';

const MODULE_MAP: Record<string, {
  fetch:    (id: string, tenantId: string) => Promise<any>;
  template: (doc: any, settings: any, customer: any, variant: string) => string;
  idField:  string;
}> = {
  quotations: { fetch: getQuotationById, template: quotationTemplate, idField: 'quotationId' },
  workorders: { fetch: getWorkorderById, template: workorderTemplate, idField: 'workOrderId' },
  contracts:  { fetch: getContractById,  template: contractTemplate,  idField: 'contractId'  },
  invoices:   { fetch: getInvoiceById,   template: invoiceTemplate,   idField: 'invoiceId'   },
};

const ALLOWED_VARIANTS = new Set(['classic', 'modern', 'minimal']);

/**
 * Shared "resolve module/doc/template → render HTML → PDF buffer" logic used
 * by both the direct download route and the share-by-email route, so the two
 * never drift out of sync.
 */
async function buildDocumentPdf(
  module: string,
  id: string,
  tenantId: string,
  branchId: string | undefined,
  templateQuery: unknown
): Promise<{ buffer: Buffer; filename: string; docObj: any } | { error: string; status: number }> {
  const entry = MODULE_MAP[module];
  if (!entry) return { error: `PDF not supported for module: ${module}`, status: 400 };

  const docType = module.slice(0, -1) as string; // e.g. 'quotations' → 'quotation'
  let variant = 'classic';
  if (templateQuery) {
    const raw = String(templateQuery).toLowerCase();
    variant = ALLOWED_VARIANTS.has(raw) ? raw : 'classic';
  } else {
    const pref = await DocTemplatePreference.findOne({ tenantId, docType }).lean();
    if (pref && ALLOWED_VARIANTS.has(pref.defaultVariant)) variant = pref.defaultVariant;
  }

  const doc = await entry.fetch(id, tenantId);
  if (!doc) return { error: 'Document not found', status: 404 };

  const docObj = doc.toObject ? doc.toObject() : doc;

  // Enrich with FSSettings: prefer branch-specific settings, fall back to main-org
  const bid = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const settings = await FSSettings.findOne({ tenantId, branchId: bid }).lean().exec()
    ?? await FSSettings.findOne({ tenantId, branchId: null }).lean().exec()
    ?? {};

  // Resolve customer name/address from customerId string
  const customer = docObj.customerId
    ? await NativeCustomer.findOne({ tenantId, customerId: docObj.customerId }).lean().exec()
    : null;

  // Check if a custom template is the default for this tenant+docType
  const customTpl = await CustomTemplate.findOne({ tenantId, docType, isDefault: true }).lean();

  const html = customTpl
    ? renderCustomTemplate(customTpl.elements, docObj, settings, customer)
    : entry.template(docObj, settings, customer, variant);

  const buffer   = await generatePdfFromHtml(html);
  const filename = `${docType}-${docObj[entry.idField] ?? id}.pdf`;

  return { buffer, filename, docObj };
}

export async function generatePdf(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const result = await buildDocumentPdf(module, id, req.tenantId!, req.branchId, req.query.template);
    if ('error' in result) return sendError(res, result.error, result.status);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.buffer.length);
    res.send(result.buffer);
  } catch (err: any) {
    sendError(res, err.message ?? 'PDF generation failed', 500);
  }
}

export async function shareDocumentEmail(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const { to, cc, subject, message } = req.body as {
      to: string; cc?: string[]; subject: string; message?: string;
    };

    const result = await buildDocumentPdf(module, id, req.tenantId!, req.branchId, req.query.template);
    if ('error' in result) return sendError(res, result.error, result.status);

    const bodyHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <p style="white-space:pre-wrap">${(message ?? '').replace(/</g, '&lt;')}</p>
      </div>
    `;

    await sendEmailNow({
      to,
      cc,
      subject,
      htmlContent: bodyHtml,
      attachment: [{ name: result.filename, content: result.buffer.toString('base64') }],
    });

    sendSuccess(res, { sent: true });
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to send email', 500);
  }
}
