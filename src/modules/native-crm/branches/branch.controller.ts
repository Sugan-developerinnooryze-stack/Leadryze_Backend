import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import {
  listBranches,
  getBranchById,
  createBranch,
  updateBranch,
  deactivateBranch,
  getBranchLimitInfo,
} from './branch.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listBranches(req.tenantId!, includeInactive);
    const limitInfo = await getBranchLimitInfo(req.tenantId!);
    sendSuccess(res, { items, ...limitInfo });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getBranchById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Branch not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createBranch(req.tenantId!, req.body);
    sendCreated(res, item);
  } catch (err: any) {
    const status = err.message.includes('limit reached') ? 400 : 400;
    sendError(res, err.message, status);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateBranch(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Branch not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function deactivate(req: AuthRequest, res: Response) {
  try {
    const item = await deactivateBranch(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Branch not found', 404);
    sendSuccess(res, item, 'Branch deactivated');
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
