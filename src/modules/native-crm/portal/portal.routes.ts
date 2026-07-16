import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../../../middlewares/auth.middleware';
import { requireTenant } from '../../../middlewares/tenant.middleware';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeContract }  from '../contracts/contract.model';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeInvoice }   from '../invoices/invoice.model';
import { FSSettings }      from '../fs-settings/fs-settings.model';

type DocType = 'quotation' | 'contract' | 'workorder' | 'invoice';

const MODEL_MAP: Record<DocType, any> = {
  quotation: NativeQuotation,
  contract:  NativeContract,
  workorder: NativeWorkorder,
  invoice:   NativeInvoice,
};

const ID_FIELD: Record<DocType, string> = {
  quotation: 'quotationId',
  contract:  'contractId',
  workorder: 'workOrderId',
  invoice:   'invoiceId',
};

const router = Router();

/**
 * POST /api/v1/portal/generate-token
 * Authenticated: generates a portalToken on a document and returns the share URL.
 */
router.post('/generate-token', authenticate, requireTenant, async (req: AuthRequest, res: Response) => {
  try {
    const { docType, docId } = req.body as { docType: DocType; docId: string };
    if (!docType || !docId || !MODEL_MAP[docType]) {
      return sendError(res, 'Invalid docType or docId', 400);
    }
    const token = uuidv4();
    const doc = await MODEL_MAP[docType].findByIdAndUpdate(
      docId,
      { portalToken: token },
      { new: true }
    );
    if (!doc) return sendError(res, 'Document not found', 404);
    sendSuccess(res, { token, docType, docId });
  } catch {
    sendError(res, 'Failed to generate portal token', 500);
  }
});

/**
 * GET /api/v1/portal/:token
 * Public: returns portal data for the customer without authentication.
 */
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    // Search all models for this token
    let foundDoc: any = null;
    let foundType: DocType | null = null;

    for (const [type, model] of Object.entries(MODEL_MAP) as [DocType, any][]) {
      const doc = await model.findOne({ portalToken: token }).lean();
      if (doc) {
        foundDoc = doc;
        foundType = type;
        break;
      }
    }

    if (!foundDoc || !foundType) {
      return sendError(res, 'Portal link not found or expired', 404);
    }

    const tenantId = foundDoc.tenantId;
    const settings = await FSSettings.findOne({ tenantId }).lean();
    const pipeline: string[] = (settings as any)?.workflowSteps ?? ['quotation', 'workorder', 'invoice'];

    // Build pipeline step states
    const steps = pipeline.map((step) => ({
      step,
      label:
        step === 'quotation' ? 'Quotation'
        : step === 'contract' ? 'Contract'
        : step === 'workorder' ? 'Work Order'
        : 'Invoice',
      state: step === foundType ? foundDoc.workflowState ?? 'pending'
        : pipeline.indexOf(step) < pipeline.indexOf(foundType)
          ? 'complete'
          : 'pending',
      docId: step === foundType ? foundDoc[ID_FIELD[step as DocType]] : null,
    }));

    sendSuccess(res, {
      docType:       foundType,
      docId:         foundDoc[ID_FIELD[foundType]],
      title:         foundDoc.title,
      status:        foundDoc.status,
      workflowState: foundDoc.workflowState ?? 'pending',
      scheduledDate: (foundDoc as any).scheduledDate ?? null,
      companyName:   (settings as any)?.companyName  ?? '',
      companyLogo:   (settings as any)?.companyLogo  ?? '',
      pipeline:      steps,
    });
  } catch {
    sendError(res, 'Failed to load portal data', 500);
  }
});

export default router;
