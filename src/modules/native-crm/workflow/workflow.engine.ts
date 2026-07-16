import mongoose from 'mongoose';
import { NativeQuotation } from '../quotations/quotation.model';
import { NativeContract }  from '../contracts/contract.model';
import { NativeWorkorder } from '../workorders/workorder.model';
import { NativeInvoice }   from '../invoices/invoice.model';

export type DocType = 'quotation' | 'contract' | 'workorder' | 'invoice';

const MODEL_MAP: Record<DocType, mongoose.Model<any>> = {
  quotation: NativeQuotation,
  contract:  NativeContract,
  workorder: NativeWorkorder,
  invoice:   NativeInvoice,
};

/** Returns the next pipeline step after `current`, or null if it's the last. */
export function getNextStep(current: DocType, steps: string[]): DocType | null {
  const idx = steps.indexOf(current);
  if (idx < 0 || idx >= steps.length - 1) return null;
  return steps[idx + 1] as DocType;
}

/**
 * Marks the source document workflowState='complete' and the child document
 * workflowState='in_progress'. Safe to call fire-and-forget.
 */
export async function advanceWorkflow(
  sourceRef: { type: DocType; mongoId: string },
  childRef:  { type: DocType; mongoId: string }
): Promise<void> {
  const [sourceModel, childModel] = [MODEL_MAP[sourceRef.type], MODEL_MAP[childRef.type]];
  await Promise.all([
    sourceModel.findByIdAndUpdate(sourceRef.mongoId, { workflowState: 'complete' }),
    childModel.findByIdAndUpdate(childRef.mongoId,   { workflowState: 'in_progress' }),
  ]);
}
