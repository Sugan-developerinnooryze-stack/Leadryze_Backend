import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendError, sendSuccess } from '../../../utils/response';
import { getQuotationById } from '../quotations/quotation.service';
import { getWorkorderById } from '../workorders/workorder.service';
import { getContractById }  from '../contracts/contract.service';
import { getInvoiceById }   from '../invoices/invoice.service';
import { generatePdfFromHtml, PdfOptions } from './pdf.service';
import {
  quotationTemplate,
  workorderTemplate,
  contractTemplate,
  invoiceTemplate,
} from './pdf.templates';
import { FSSettings }            from '../fs-settings/fs-settings.model';
import { NativeCustomer }        from '../customers/customer.model';
import { NativeSite }            from '../sites/site.model';
import { NativeStaff }           from '../staffs/staff.model';
import { NativeTeam }            from '../teams/team.model';
import { DocTemplatePreference, ITemplateSections, DEFAULT_TEMPLATE_SECTIONS } from '../fs-settings/doc-template-preference.model';
import { CustomTemplate, IDesignElement, ITemplatePage, ITemplateRegion, TemplateDocType } from '../custom-templates/custom-template.model';
import { NativeCustomField }     from '../custom-fields/custom-field.model';
import { renderCustomTemplateFull } from './pdf.variable-renderer';
import {
  RenderCtx, MODULE_FOR_DOCTYPE, currencySymbol,
  buildVarMap, cellValue, totalsValue,
} from './variable-catalog';
import { sendEmailNow }          from '../../messages/brevo.service';
import { getOutcomeStageKey }    from '../pipeline-config/pipeline-config.service';

/** Resolved once per render — see RenderCtx.invoicePaidKey. */
async function resolveInvoicePaidKey(docType: TemplateDocType, tenantId: string): Promise<string | undefined> {
  if (docType !== 'invoice') return undefined;
  return getOutcomeStageKey(tenantId, 'invoice', 'paid', 'paid');
}

const MODULE_MAP: Record<string, {
  fetch:    (id: string, tenantId: string) => Promise<any>;
  template: (doc: any, settings: any, customer: any, variant: string, sections?: Partial<ITemplateSections>) => string;
  idField:  string;
}> = {
  quotations: { fetch: getQuotationById, template: quotationTemplate, idField: 'quotationId' },
  workorders: { fetch: getWorkorderById, template: workorderTemplate, idField: 'workOrderId' },
  contracts:  { fetch: getContractById,  template: contractTemplate,  idField: 'contractId'  },
  invoices:   { fetch: getInvoiceById,   template: invoiceTemplate,   idField: 'invoiceId'   },
};

const ALLOWED_VARIANTS = new Set(['classic', 'modern', 'minimal', 'elegant']);

interface BuildHtmlOptions {
  templateId?:    string;          // explicit designer template
  variant?:       unknown;         // ?template= query (legacy variants)
  draftElements?: IDesignElement[]; // unsaved designer draft (preview only)
  draftPage?:     ITemplatePage;
  draftHeader?:   ITemplateRegion;
  draftFooter?:   ITemplateRegion;
}

interface BuiltHtml {
  html:        string;
  pdfOptions:  PdfOptions;
  docObj:      any;
  filename:    string;
}

interface ResolvedDoc {
  entry:    typeof MODULE_MAP[string];
  docType:  TemplateDocType;
  docObj:   any;
  settings: any;
  customer: any;
  filename: string;
  site:     any;
  staff:    any;
  team:     any;
}

/**
 * Shared "fetch doc + settings + customer" step used by every PDF consumption
 * path (download, share-email, preview, live-data) so they can never drift.
 */
async function resolveRenderCtx(
  module: string,
  id: string,
  tenantId: string,
  branchId: string | undefined,
): Promise<ResolvedDoc | { error: string; status: number }> {
  const entry = MODULE_MAP[module];
  if (!entry) return { error: `PDF not supported for module: ${module}`, status: 400 };

  const docType = module.slice(0, -1) as TemplateDocType;

  const doc = await entry.fetch(id, tenantId);
  if (!doc) return { error: 'Document not found', status: 404 };
  const docObj = doc.toObject ? doc.toObject() : doc;

  // Enrich with FSSettings: prefer branch-specific settings, fall back to main-org
  const bid = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const settings = await FSSettings.findOne({ tenantId, branchId: bid }).lean().exec()
    ?? await FSSettings.findOne({ tenantId, branchId: null }).lean().exec()
    ?? {};

  const customer = docObj.customerId
    ? await NativeCustomer.findOne({ tenantId, customerId: docObj.customerId }).lean().exec()
    : null;

  // Assigned site/staff/team — only contracts/workorders carry these fields,
  // stored as human-readable codes (not ObjectId refs), so look up by code.
  let site: any = null, staff: any = null, team: any = null;
  if (docType === 'contract' || docType === 'workorder') {
    [site, staff, team] = await Promise.all([
      docObj.siteId  ? NativeSite.findOne({ tenantId, siteId: docObj.siteId }).select('name').lean().exec()   : null,
      docObj.staffId ? NativeStaff.findOne({ tenantId, staffId: docObj.staffId }).select('firstName lastName').lean().exec() : null,
      docObj.teamId  ? NativeTeam.findOne({ tenantId, teamId: docObj.teamId }).select('name').lean().exec()   : null,
    ]);
  }

  const filename = `${docType}-${docObj[entry.idField] ?? id}.pdf`;

  return { entry, docType, docObj, settings, customer, filename, site, staff, team };
}

/**
 * Shared "resolve doc → pick template → render HTML" logic used by download,
 * share-email, and preview so they can never drift apart.
 *
 * Template precedence: draft elements (preview) → explicit templateId →
 * tenant default CustomTemplate → legacy variant (?template= or saved
 * DocTemplatePreference) → classic.
 */
async function buildDocumentHtml(
  module: string,
  id: string,
  tenantId: string,
  branchId: string | undefined,
  opts: BuildHtmlOptions,
): Promise<BuiltHtml | { error: string; status: number }> {
  const resolved = await resolveRenderCtx(module, id, tenantId, branchId);
  if ('error' in resolved) return resolved;
  const { entry, docType, docObj, settings, customer, filename, site, staff, team } = resolved;

  // ── Designer-template paths ────────────────────────────────────────────────
  let designerElements: IDesignElement[] | null = null;
  let designerPage: ITemplatePage | undefined;
  let designerHeader: ITemplateRegion | undefined;
  let designerFooter: ITemplateRegion | undefined;

  if (opts.draftElements) {
    designerElements = opts.draftElements;
    designerPage = opts.draftPage;
    designerHeader = opts.draftHeader;
    designerFooter = opts.draftFooter;
  } else if (opts.templateId) {
    const tpl = await CustomTemplate.findOne({ _id: opts.templateId, tenantId }).lean();
    if (!tpl) return { error: 'Template not found', status: 404 };
    if (tpl.docType !== docType) return { error: 'Template docType does not match document', status: 400 };
    designerElements = tpl.elements;
    designerPage = tpl.page;
    designerHeader = tpl.header;
    designerFooter = tpl.footer;
  } else {
    const tpl = await CustomTemplate.findOne({ tenantId, docType, isDefault: true }).lean();
    if (tpl) {
      designerElements = tpl.elements; designerPage = tpl.page;
      designerHeader = tpl.header; designerFooter = tpl.footer;
    }
  }

  if (designerElements) {
    const customFieldDefs = await NativeCustomField.find({
      tenantId,
      module: MODULE_FOR_DOCTYPE[docType],
      isActive: true,
    }).select('fieldKey label fieldType').lean();

    const ctx: RenderCtx = {
      doc: docObj,
      settings,
      customer,
      docType,
      cur: currencySymbol((settings as any)?.currency),
      customFieldDefs,
      site, staff, team,
      invoicePaidKey: await resolveInvoicePaidKey(docType, tenantId),
    };
    const rendered = renderCustomTemplateFull(designerElements, ctx, designerPage, designerHeader, designerFooter);
    return {
      html: rendered.html,
      pdfOptions: { marginTopPx: rendered.pageOptions.marginTopPx, marginBottomPx: rendered.pageOptions.marginBottomPx },
      docObj,
      filename,
    };
  }

  // ── Legacy hardcoded variants ──────────────────────────────────────────────
  // Fetched once regardless of whether a variant was passed explicitly — the
  // per-tenant section-visibility toggle (Services/Parts/Totals/Notes/Terms)
  // always applies, independent of which variant is used.
  const pref = await DocTemplatePreference.findOne({ tenantId, docType }).lean();
  let variant = 'classic';
  if (opts.variant) {
    const raw = String(opts.variant).toLowerCase();
    variant = ALLOWED_VARIANTS.has(raw) ? raw : 'classic';
  } else if (pref && ALLOWED_VARIANTS.has(pref.defaultVariant)) {
    variant = pref.defaultVariant;
  }
  const sections: ITemplateSections = { ...DEFAULT_TEMPLATE_SECTIONS, ...(pref?.sections ?? {}) };

  // Site/Staff/Team are already resolved to real records above (for
  // contract/workorder) — merge their display names in so the legacy
  // templates can print a name instead of the raw internal code.
  const enrichedDoc = {
    ...docObj,
    siteName:  site?.name,
    staffName: staff ? `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim() : undefined,
    teamName:  team?.name,
  };

  const html = entry.template(enrichedDoc, settings, customer, variant, sections);
  return { html, pdfOptions: {}, docObj, filename };
}

export async function generatePdf(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const result = await buildDocumentHtml(module, id, req.tenantId!, req.branchId, {
      templateId: req.query.templateId ? String(req.query.templateId) : undefined,
      variant:    req.query.template,
    });
    if ('error' in result) return sendError(res, result.error, result.status);

    const buffer = await generatePdfFromHtml(result.html, result.pdfOptions);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err: any) {
    sendError(res, err.message ?? 'PDF generation failed', 500);
  }
}

/** GET — rendered HTML for the doc using saved template / default / variant. */
export async function previewHtml(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const result = await buildDocumentHtml(module, id, req.tenantId!, req.branchId, {
      templateId: req.query.templateId ? String(req.query.templateId) : undefined,
      variant:    req.query.template,
    });
    if ('error' in result) return sendError(res, result.error, result.status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result.html);
  } catch (err: any) {
    sendError(res, err.message ?? 'Preview failed', 500);
  }
}

/** POST — rendered HTML for an UNSAVED designer draft (body validated in route). */
export async function previewDraftHtml(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const { elements, page, header, footer } = req.body as {
      elements: IDesignElement[]; page?: ITemplatePage; header?: ITemplateRegion; footer?: ITemplateRegion;
    };
    const result = await buildDocumentHtml(module, id, req.tenantId!, req.branchId, {
      draftElements: elements,
      draftPage:     page,
      draftHeader:   header,
      draftFooter:   footer,
    });
    if ('error' in result) return sendError(res, result.error, result.status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result.html);
  } catch (err: any) {
    sendError(res, err.message ?? 'Preview failed', 500);
  }
}

/** POST — real PDF download for an UNSAVED designer draft (same source HTML as previewDraftHtml). */
export async function downloadDraftPdf(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const { elements, page, header, footer } = req.body as {
      elements: IDesignElement[]; page?: ITemplatePage; header?: ITemplateRegion; footer?: ITemplateRegion;
    };
    const result = await buildDocumentHtml(module, id, req.tenantId!, req.branchId, {
      draftElements: elements,
      draftPage:     page,
      draftHeader:   header,
      draftFooter:   footer,
    });
    if ('error' in result) return sendError(res, result.error, result.status);

    const buffer = await generatePdfFromHtml(result.html, result.pdfOptions);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err: any) {
    sendError(res, err.message ?? 'PDF generation failed', 500);
  }
}

// Reverses esc() — buildVarMap()/cellValue() HTML-escape everything for safe
// {{token}} substitution into markup; the live-data endpoint instead feeds
// plain values to the designer canvas (a React text node, not raw HTML), so
// callers unescape before display. The 4 replacements are disjoint literal
// tokens (none is a substring of another), so order doesn't matter.
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * GET — pre-resolved real data for the designer's "Live Data" canvas mode:
 * scalar {{token}} values, real services/parts rows (already run through the
 * same cellValue() the PDF renderer uses — per-column values are small,
 * pre-escaped HTML fragments, e.g. `<b>Name</b>`, meant to be inserted with
 * dangerouslySetInnerHTML, not treated as plain text), and every totals row
 * pre-computed. Depends only on the saved document, not on any in-progress
 * designer draft — no request body needed.
 */
export async function getLiveData(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const resolved = await resolveRenderCtx(module, id, req.tenantId!, req.branchId);
    if ('error' in resolved) return sendError(res, resolved.error, resolved.status);
    const { docType, docObj, settings, customer, site, staff, team } = resolved;

    const customFieldDefs = await NativeCustomField.find({
      tenantId: req.tenantId!,
      module: MODULE_FOR_DOCTYPE[docType],
      isActive: true,
    }).select('fieldKey label fieldType').lean();

    const ctx: RenderCtx = {
      doc: docObj,
      settings,
      customer,
      docType,
      cur: currencySymbol((settings as any)?.currency),
      customFieldDefs,
      site, staff, team,
      invoicePaidKey: await resolveInvoicePaidKey(docType, req.tenantId!),
    };

    const rawVars = buildVarMap(ctx);
    const vars = Object.fromEntries(
      Object.entries(rawVars).map(([k, v]) => [k, unescapeHtml(v)])
    );

    const ROW_COLUMN_KEYS = ['index', 'name', 'description', 'partNumber', 'count', 'amount', 'lineTotal'];
    const rowCells = (rows: any[]) => rows.map((row, i) =>
      Object.fromEntries(ROW_COLUMN_KEYS.map((k) => [k, cellValue(row, k, i, ctx.cur)]))
    );

    const ALL_TOTALS_KEYS = ['servicesSubtotal', 'partsSubtotal', 'subtotal', 'discount', 'gst', 'total', 'paid', 'balance'] as const;
    const totals = Object.fromEntries(ALL_TOTALS_KEYS.map((k) => [k, totalsValue(k, ctx)]));

    sendSuccess(res, {
      vars,
      services: rowCells(docObj.services ?? []),
      parts:    rowCells(docObj.parts ?? []),
      totals,
      docLabel: docObj[resolved.entry.idField] ?? id,
    });
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to load live data', 500);
  }
}

export async function shareDocumentEmail(req: AuthRequest, res: Response) {
  try {
    const { module, id } = req.params;
    const { to, cc, subject, message } = req.body as {
      to: string; cc?: string[]; subject: string; message?: string;
    };

    const result = await buildDocumentHtml(module, id, req.tenantId!, req.branchId, {
      templateId: req.query.templateId ? String(req.query.templateId) : undefined,
      variant:    req.query.template,
    });
    if ('error' in result) return sendError(res, result.error, result.status);

    const buffer = await generatePdfFromHtml(result.html, result.pdfOptions);

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
      attachment: [{ name: result.filename, content: buffer.toString('base64') }],
    });

    sendSuccess(res, { sent: true });
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to send email', 500);
  }
}
