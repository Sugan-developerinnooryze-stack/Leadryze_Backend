import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import { listAssets, getAssetById, createAsset, updateAsset, deleteAsset } from './asset.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listAssets(req.tenantId!, req.query as any, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) { sendError(res, err.message, 500); }
}
export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getAssetById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Asset not found', 404);
    sendSuccess(res, item);
  } catch (err: any) { sendError(res, err.message, 500); }
}
export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createAsset({ ...req.body, tenantId: req.tenantId!, branchId: req.body.branchId ?? req.branchId ?? null, createdBy: req.user?.userId });
    sendCreated(res, item);
  } catch (err: any) { sendError(res, err.message, 400); }
}
export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateAsset(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Asset not found', 404);
    sendSuccess(res, item);
  } catch (err: any) { sendError(res, err.message, 400); }
}
export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteAsset(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Asset not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) { sendError(res, err.message, 500); }
}
