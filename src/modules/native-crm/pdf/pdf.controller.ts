import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendError } from '../../../utils/response';
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

export async function generatePdf(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const entry = MODULE_MAP[module];
    if (!entry) return sendError(res, `PDF not supported for module: ${module}`, 400);

    // If caller passed ?template=, use it; otherwise fall back to tenant's saved default
    const docType = module.slice(0, -1) as string; // e.g. 'quotations' → 'quotation'
    let variant = 'classic';
    if (req.query.template) {
      const raw = String(req.query.template).toLowerCase();
      variant = ALLOWED_VARIANTS.has(raw) ? raw : 'classic';
    } else {
      const pref = await DocTemplatePreference.findOne({ tenantId: req.tenantId, docType }).lean();
      if (pref && ALLOWED_VARIANTS.has(pref.defaultVariant)) variant = pref.defaultVariant;
    }

    const doc = await entry.fetch(id, req.tenantId!);
    if (!doc) return sendError(res, 'Document not found', 404);

    const docObj = doc.toObject ? doc.toObject() : doc;

    // Enrich with FSSettings: prefer branch-specific settings, fall back to main-org
    const tid = req.tenantId;
    const bid = req.branchId ? new mongoose.Types.ObjectId(req.branchId) : null;
    const settings = await FSSettings.findOne({ tenantId: tid, branchId: bid }).lean().exec()
      ?? await FSSettings.findOne({ tenantId: tid, branchId: null }).lean().exec()
      ?? {};

    // Resolve customer name/address from customerId string
    const customer = docObj.customerId
      ? await NativeCustomer.findOne({ tenantId: req.tenantId, customerId: docObj.customerId }).lean().exec()
      : null;

    // Check if a custom template is the default for this tenant+docType
    const customTpl = await CustomTemplate.findOne({
      tenantId:  req.tenantId,
      docType,
      isDefault: true,
    }).lean();

    const html = customTpl
      ? renderCustomTemplate(customTpl.elements, docObj, settings, customer)
      : entry.template(docObj, settings, customer, variant);

    const buffer   = await generatePdfFromHtml(html);
    const filename = `${module.slice(0, -1)}-${docObj[entry.idField] ?? id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err: any) {
    sendError(res, err.message ?? 'PDF generation failed', 500);
  }
}
