import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listReceipts,
  getReceiptById,
  createReceiptWithOutcome,
  updateReceipt,
  deleteReceipt,
} from './receipt.service';
import { resolveEffectiveScope } from '../shared/data-scope';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listReceipts(req.tenantId!, req.query as any, req.branchId, resolveEffectiveScope(req, 'receipts'));
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getReceiptById(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'receipts'));
    if (!item) return sendError(res, 'Receipt not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

// LR-C4-RCPT-005: the idempotency key comes from the Idempotency-Key header
// (or X-Idempotency-Key) or the body's idempotencyKey (which the validation
// now keeps). A request the service recognises as already recorded gets that
// receipt with 200 and replayed: true, never 201 "Created successfully", so
// no caller is told a second payment was saved when it was not; a key reused
// with different payment details gets 409.
export async function create(req: AuthRequest, res: Response) {
  try {
    const header = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
    const headerKey = (Array.isArray(header) ? header[0] : header)?.trim();
    if (headerKey !== undefined && headerKey !== '' && (headerKey.length < 8 || headerKey.length > 128)) {
      return sendError(res, 'Idempotency-Key must be 8 to 128 characters', 400);
    }
    const { receipt, replayed } = await createReceiptWithOutcome({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
      idempotencyKey: headerKey || req.body?.idempotencyKey,
    });
    if (replayed) {
      const plain = typeof receipt?.toObject === 'function' ? receipt.toObject() : receipt;
      return sendSuccess(res, { ...plain, replayed: true }, 'This payment was already recorded; the existing receipt is returned');
    }
    sendCreated(res, receipt);
  } catch (err: any) {
    sendError(res, err.message, err?.statusCode === 409 ? 409 : 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateReceipt(req.params.id, req.tenantId!, req.body, resolveEffectiveScope(req, 'receipts'));
    if (!item) return sendError(res, 'Receipt not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteReceipt(req.params.id, req.tenantId!, resolveEffectiveScope(req, 'receipts'));
    if (!item) return sendError(res, 'Receipt not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
